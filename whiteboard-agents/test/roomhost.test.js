// Room-host behaviors: N identities in one process, shared scene, per-agent
// diffs, runtime cast changes, primary-socket promotion, tombstone compaction.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startRelay } from "./relay-fixture.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WB = path.join(PKG_ROOT, "bin", "wb.js");

const relay = await startRelay();
process.env.WB_WS_SERVER = relay.url;
const { ExcalidrawClient } = await import("../lib/client.js");

const ROOM_ID = "roomhost-test-room";
const ROOM_KEY = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-rh-"));

let hostProc;
let port;

const api = async (method, pathname, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

test.before(async () => {
  hostProc = spawn(
    process.execPath,
    [
      WB,
      "host",
      "--room",
      `${ROOM_ID},${ROOM_KEY}`,
      "--agents-json",
      JSON.stringify([
        { name: "Alpha", color: "#e03131", background: "#ffc9c9", slot: 0 },
        { name: "Beta", color: "#2f9e44", background: "#b2f2bb", slot: 1 },
      ]),
    ],
    {
      env: {
        ...process.env,
        WB_WS_SERVER: relay.url,
        WB_STATE_DIR: stateDir,
        WB_DELIVERABLES_DIR: path.join(stateDir, "deliverables"),
        WB_NO_PERSIST: "1",
        WB_DEBOUNCE_MS: "100",
        WB_TOMBSTONE_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const roomInfoPath = path.join(stateDir, ROOM_ID, "room.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(roomInfoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(roomInfoPath, "utf8"));
        if ((info.agents || []).length === 2) {
          port = info.port;
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.ok) return;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("room host did not come up against the fixture");
});

test.after(async () => {
  hostProc?.kill();
  await relay.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("one host carries both identities on one port", async () => {
  const { data } = await api("GET", "/health");
  assert.equal(data.ok, true);
  assert.equal(data.version, 2);
  const names = data.agents.map((a) => a.name).sort();
  assert.deepEqual(names, ["Alpha", "Beta"]);
  assert.equal(data.agents.filter((a) => a.primary).length, 1);
  assert.ok(data.agents.every((a) => a.connected));
  // two sockets in the room, one per identity
  assert.equal(data.collaborators, 2);

  // info files: room.json + per-agent compat files, all pointing at one port
  const dir = path.join(stateDir, ROOM_ID);
  const room = JSON.parse(fs.readFileSync(path.join(dir, "room.json"), "utf8"));
  for (const name of ["Alpha", "Beta"]) {
    const info = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
    assert.equal(info.port, room.port);
    assert.equal(info.pid, room.pid);
  }
});

test("agent-scoped routes require the agent name when several run", async () => {
  const { status } = await api("GET", "/diff");
  assert.equal(status, 400);
});

test("ops are attributed per agent; sibling work shows in the other's diff only", async () => {
  const { data: op } = await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "text", text: "from alpha", x: 10, y: 10 }],
  });
  assert.equal(op.ids.length, 1);

  const { data: alpha } = await api("GET", "/diff?agent=Alpha");
  assert.deepEqual(alpha.changes, [], "own work is pre-acked");

  const { data: beta } = await api("GET", "/diff?agent=Beta");
  assert.equal(beta.changes.length, 1);
  assert.equal(beta.changes[0].author, "Alpha");

  await api("POST", "/ack?agent=Beta", { ids: op.ids });
  const { data: after } = await api("GET", "/diff?agent=Beta");
  assert.deepEqual(after.changes, []);
});

test("human changes reach every agent's diff through the shared scene", async (t) => {
  const human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  t.after(() => human.close());
  await human.connect();
  await human.syncElements([
    { id: "h-1", type: "rectangle", x: 0, y: 0, width: 9, height: 9, version: 1, versionNonce: 1 },
  ]);
  for (const agent of ["Alpha", "Beta"]) {
    let changes = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      ({ data: { changes } } = await api("GET", `/diff?agent=${agent}`));
      if (changes.some((c) => c.id === "h-1")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(changes.some((c) => c.id === "h-1"), `${agent} should see the human element`);
    await api("POST", `/ack?agent=${agent}`, { ids: ["h-1"] });
  }
});

test("status cards carry a FIXED Role line that the human owns", async (t) => {
  await api("POST", "/op?agent=Alpha", { ops: [{ op: "status", text: "reading the board" }] });
  const { data: d1 } = await api("GET", "/diff?agent=Alpha");
  assert.equal(d1.role, "None", "role defaults to None");

  const { data: scene1 } = await api("GET", "/scene?full=1");
  const card = scene1.elements.find((e) => e.id === "wb-status-Alpha");
  assert.match(card.text, /^🤖 Alpha\nFIXED Role: None\nreading the board$/);

  // the human pins a role by editing the card on the canvas
  const human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  t.after(() => human.close());
  await human.connect();
  const pinned = "🤖 Alpha\nFIXED Role: skeptic\nreading the board";
  await human.syncElements([
    { ...card, text: pinned, originalText: pinned, version: card.version + 1, versionNonce: card.versionNonce + 1 },
  ]);

  let role = "None";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && role !== "skeptic") {
    ({ data: { role } } = await api("GET", "/diff?agent=Alpha"));
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(role, "skeptic", "role edits surface in every response");
  const { data: d2 } = await api("GET", "/diff?agent=Alpha");
  assert.ok(
    !d2.changes.some((c) => c.id === "wb-status-Alpha"),
    "own status card never lands in the diff",
  );

  // the next status write preserves the human's role line
  await api("POST", "/op?agent=Alpha", { ops: [{ op: "status", text: "linked two notes" }] });
  const { data: scene2 } = await api("GET", "/scene?full=1");
  const card2 = scene2.elements.find((e) => e.id === "wb-status-Alpha");
  assert.match(card2.text, /^🤖 Alpha\nFIXED Role: skeptic\nlinked two notes$/);
});

test("a parked wait wakes when the human edits the role line", async (t) => {
  await api("POST", "/op?agent=Beta", { ops: [{ op: "status", text: "idle" }] });
  await api("GET", "/diff?agent=Beta"); // sets lastRoleSeen

  const waiting = api("GET", "/wait?agent=Beta&timeout=8");
  await new Promise((r) => setTimeout(r, 200)); // let the waiter park

  const human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  t.after(() => human.close());
  await human.connect();
  const { data: scene } = await api("GET", "/scene?full=1");
  const card = scene.elements.find((e) => e.id === "wb-status-Beta");
  const pinned = card.text.replace("FIXED Role: None", "FIXED Role: connector");
  await human.syncElements([
    { ...card, text: pinned, originalText: pinned, version: card.version + 1, versionNonce: card.versionNonce + 1 },
  ]);

  const { data } = await waiting;
  assert.equal(data.roleChanged, true, "wait resolves on a role edit, not just board changes");
  assert.equal(data.role, "connector");
});

test("claims share the workload: first claim wins, release frees", async () => {
  const { data: op } = await api("POST", "/op?agent=Alpha", {
    ops: [
      { op: "text", text: "item one", x: 400, y: 400 },
      { op: "text", text: "item two", x: 400, y: 450 },
    ],
  });
  const [one, two] = op.ids;

  const { data: a } = await api("POST", "/claim?agent=Alpha", { ids: [one, two] });
  assert.deepEqual(a.granted.sort(), [one, two].sort());

  const { data: b } = await api("POST", "/claim?agent=Beta", { ids: [one] });
  assert.deepEqual(b.granted, []);
  assert.equal(b.denied[one], "Alpha");

  // siblings see the reservation in summaries
  const { data: scene } = await api("GET", "/scene");
  assert.equal(scene.elements.find((e) => e.id === one).claimedBy, "Alpha");

  // holder's claims ride along in contextInfo
  const { data: diff } = await api("GET", "/diff?agent=Alpha");
  assert.ok(diff.claims.some((c) => c.id === one));

  const { data: rel } = await api("POST", "/claim?agent=Alpha", { ids: [one], release: true });
  assert.deepEqual(rel.granted, [one]);
  const { data: b2 } = await api("POST", "/claim?agent=Beta", { ids: [one] });
  assert.deepEqual(b2.granted, [one]);

  // cleanup so later tests see no stale claims
  await api("POST", "/claim?agent=Beta", { ids: [one], release: true });
  await api("POST", "/claim?agent=Alpha", { ids: [two], release: true });
});

test("arrows bind to their endpoints and carry a bound label", async () => {
  const { data: n1 } = await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "note", text: "cause", x: 1000, y: 1000 }],
  });
  const { data: n2 } = await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "note", text: "effect", x: 1400, y: 1000 }],
  });
  const [fromId] = n1.ids;
  const [toId] = n2.ids;

  const { data: ar } = await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "arrow", from: fromId, to: toId, label: "feeds into" }],
  });
  const { data: scene } = await api("GET", "/scene?full=1");
  const arrow = scene.elements.find((e) => ar.ids.includes(e.id) && e.type === "arrow");
  const label = scene.elements.find((e) => ar.ids.includes(e.id) && e.type === "text");

  assert.equal(arrow.startBinding?.elementId, fromId);
  assert.equal(arrow.endBinding?.elementId, toId);
  assert.equal(label.containerId, arrow.id, "label is bound to the arrow, not floating");
  assert.deepEqual(arrow.boundElements, [{ type: "text", id: label.id }]);
  for (const endId of [fromId, toId]) {
    const end = scene.elements.find((e) => e.id === endId);
    assert.ok(
      (end.boundElements || []).some((b) => b.id === arrow.id && b.type === "arrow"),
      "endpoint knows about the arrow so drags re-route it",
    );
  }
});

test("notes carry hyperlinks; deliverables are served over /d/", async () => {
  const { data: op } = await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "note", text: "full analysis (2p)", x: 1800, y: 1000, link: "http://127.0.0.1:1/d/x.md" }],
  });
  const { data: scene } = await api("GET", "/scene");
  const note = scene.elements.find((e) => e.id === op.ids[0]);
  assert.equal(note.link, "http://127.0.0.1:1/d/x.md", "summaries surface the link");

  const dDir = path.join(stateDir, "deliverables");
  fs.mkdirSync(dDir, { recursive: true });
  fs.writeFileSync(path.join(dDir, "analysis.md"), "# hello board");
  const res = await fetch(`http://127.0.0.1:${port}/d/analysis.md`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  assert.equal(await res.text(), "# hello board");

  const evil = await fetch(`http://127.0.0.1:${port}/d/..%2Froom.json`);
  assert.equal(evil.status, 400, "path traversal is rejected");
});

test("grouped batches build one movable composite; refs wire arrows inside it", async () => {
  const { data: op } = await api("POST", "/op?agent=Alpha", {
    group: true,
    ops: [
      { op: "note", text: "premise", x: 2200, y: 1000, ref: "a" },
      { op: "note", text: "conclusion", x: 2600, y: 1000, ref: "b" },
      { op: "arrow", from: "$a", to: "$b", label: "therefore" },
    ],
  });
  assert.ok(op.groupId, "grouped batches return their groupId");

  const { data: scene } = await api("GET", "/scene?full=1");
  const created = scene.elements.filter((e) => op.ids.includes(e.id));
  assert.equal(created.length, 6); // 2 × (container+text) + arrow + label
  for (const el of created) {
    if (el.containerId) continue; // bound text follows its container
    assert.ok(
      (el.groupIds || []).includes(op.groupId),
      `${el.type} carries the batch groupId`,
    );
  }
  const arrow = created.find((e) => e.type === "arrow");
  assert.equal(arrow.startBinding?.elementId, op.ids[0], "$a resolved to the first note");
  assert.equal(arrow.endBinding?.elementId, op.ids[2], "$b resolved to the second note");
});

test("agents can put a real image on the board", async () => {
  // 1x1 transparent png
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const p = path.join(stateDir, "probe.png");
  fs.writeFileSync(p, png);
  const { data: op } = await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "image", file: p, x: 3000, y: 1000 }],
  });
  const { data: scene } = await api("GET", "/scene");
  const img = scene.elements.find((e) => e.id === op.ids[0]);
  assert.equal(img.type, "image");
  assert.ok(img.hasImage && img.fileId, "summaries flag the image");

  // served from the local cache without touching room storage (WB_NO_PERSIST)
  const res = await fetch(`http://127.0.0.1:${port}/file?id=${img.fileId}`);
  assert.equal(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(png), "decrypted bytes round-trip");
});

test("dance is a known gesture kind", async () => {
  const { data: op } = await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "text", text: "dance floor", x: 3400, y: 1000 }],
  });
  const g = await api("POST", "/gesture?agent=Alpha", { kind: "dance", target: op.ids[0] });
  assert.equal(g.status, 200);
});

test("agents can join and detach at runtime", async () => {
  const { data: joined } = await api("POST", "/agents", { name: "Gamma", color: "#f08c00" });
  assert.equal(joined.agent, "Gamma");
  const { data: h1 } = await api("GET", "/health");
  assert.equal(h1.agents.length, 3);
  assert.equal(h1.collaborators, 3);

  const del = await api("DELETE", "/agents/Gamma");
  assert.equal(del.status, 200);
  const { data: h2 } = await api("GET", "/health");
  assert.equal(h2.agents.length, 2);
});

test("detaching the primary promotes another socket and scene traffic continues", async (t) => {
  const { data: before } = await api("GET", "/health");
  const primaryName = before.agents.find((a) => a.primary).name;
  const del = await api("DELETE", `/agents/${primaryName}`);
  assert.equal(del.status, 200);

  const { data: after } = await api("GET", "/health");
  assert.equal(after.agents.length, 1);
  assert.ok(after.agents[0].primary, "remaining agent was promoted to primary");
  const survivor = after.agents[0].name;

  // scene traffic still processed by the promoted socket
  const human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  t.after(() => human.close());
  await human.connect();
  await human.syncElements([
    { id: "h-2", type: "ellipse", x: 5, y: 5, width: 9, height: 9, version: 1, versionNonce: 1 },
  ]);
  let changes = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    ({ data: { changes } } = await api("GET", `/diff?agent=${survivor}`));
    if (changes.some((c) => c.id === "h-2")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(changes.some((c) => c.id === "h-2"), "promoted primary still reconciles the scene");
  await api("POST", `/ack?agent=${survivor}`, { ids: ["h-2"] });

  // re-add the second identity for any later test
  await api("POST", "/agents", { name: "Beta2", color: "#2f9e44" });
});

test("the last agent cannot be detached (use /quit)", async () => {
  const { data: h } = await api("GET", "/health");
  const names = h.agents.map((a) => a.name);
  const del = await api("DELETE", `/agents/${names[1]}`);
  assert.equal(del.status, 200);
  const last = await api("DELETE", `/agents/${names[0]}`);
  assert.equal(last.status, 400);
  await api("POST", "/agents", { name: "Beta3" });
});

test("tombstoned elements are compacted once every agent has seen the deletion", async () => {
  const { data: h } = await api("GET", "/health");
  const [a, b] = h.agents.map((x) => x.name);

  const { data: op } = await api("POST", "/op", {
    agent: a,
    ops: [{ op: "text", text: "ephemeral", x: 700, y: 700 }],
  });
  const id = op.ids[0];
  await api("POST", "/op", { agent: a, ops: [{ op: "delete", id }] });
  // the other agent acks the deletion
  await api("POST", `/ack?agent=${b}`, { ids: [id] });
  await new Promise((r) => setTimeout(r, 120)); // > WB_TOMBSTONE_MS=50

  await api("POST", "/save");
  const { data: scene } = await api("GET", "/scene?deleted=1");
  assert.ok(
    !scene.elements.some((e) => e.id === id),
    "compaction should drop the acked, expired tombstone",
  );
});

test("tombstones NOT seen by everyone survive compaction", async () => {
  const { data: h } = await api("GET", "/health");
  const [a] = h.agents.map((x) => x.name);
  const { data: op } = await api("POST", "/op", {
    agent: a,
    ops: [{ op: "text", text: "still needed", x: 800, y: 800 }],
  });
  const id = op.ids[0];
  await api("POST", "/op", { agent: a, ops: [{ op: "delete", id }] });
  // second agent does NOT ack
  await new Promise((r) => setTimeout(r, 120));
  await api("POST", "/save");
  const { data: scene } = await api("GET", "/scene?deleted=1");
  assert.ok(
    scene.elements.some((e) => e.id === id),
    "unacked tombstone must survive so the other agent's diff can deliver it",
  );
});
