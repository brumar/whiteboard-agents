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
