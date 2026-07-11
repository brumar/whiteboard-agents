// Phase 3 behaviors: board directives handled/surfaced by the host, and the
// --on-change brain spawner (single-flight, cooldown, only when nobody waits).
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

const ROOM_ID = "phase3-test-room";
const ROOM_KEY = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-p3-"));
const markFile = path.join(stateDir, "spawn-marks.txt");

let hostProc;
let port;
let human;
let humanSeq = 0;

const api = async (method, pathname, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

const humanText = async (text, x = 0, y = 0) => {
  const el = {
    id: `h-txt-${++humanSeq}`,
    type: "text",
    x,
    y,
    width: 100,
    height: 25,
    text,
    originalText: text,
    fontSize: 20,
    fontFamily: 5,
    version: 1,
    versionNonce: humanSeq,
  };
  await human.syncElements([el]);
  return el;
};

const until = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const marks = () =>
  fs.existsSync(markFile) ? fs.readFileSync(markFile, "utf8").split("\n").filter(Boolean) : [];

test.before(async () => {
  hostProc = spawn(
    process.execPath,
    [
      WB,
      "host",
      "--room",
      `${ROOM_ID},${ROOM_KEY}`,
      "--agents-json",
      JSON.stringify([{ name: "Alpha", slot: 0 }, { name: "Beta", slot: 1 }]),
      "--on-change",
      `node -e "require('fs').appendFileSync(process.env.MARK_FILE, JSON.stringify({r:process.env.WB_REASON,t:process.env.WB_TARGET,d:process.env.WB_DIRECTIVE}) + '\\n')"`,
    ],
    {
      env: {
        ...process.env,
        WB_WS_SERVER: relay.url,
        WB_STATE_DIR: stateDir,
        WB_NO_PERSIST: "1",
        WB_DEBOUNCE_MS: "100",
        WB_SPAWN_COOLDOWN: "1",
        MARK_FILE: markFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const roomInfoPath = path.join(stateDir, ROOM_ID, "room.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      port = JSON.parse(fs.readFileSync(roomInfoPath, "utf8")).port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!port) throw new Error("host did not come up");
  human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  await human.connect();
});

test.after(async () => {
  human?.close();
  hostProc?.kill();
  await relay.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("summons are surfaced as structured directives to the targeted agent only", async () => {
  await humanText("@Alpha what would break this?", 100, 100);
  assert.ok(
    await until(async () => {
      const { data } = await api("GET", "/diff?agent=Alpha");
      return (data.directives || []).some((d) => d.target === "Alpha");
    }),
    "Alpha should receive the directive",
  );
  const { data: alpha } = await api("GET", "/diff?agent=Alpha");
  const d = alpha.directives.find((x) => x.target === "Alpha");
  assert.equal(d.verb, "what");
  assert.match(d.text, /break this/);
  assert.equal(typeof d.x, "number");

  const { data: beta } = await api("GET", "/diff?agent=Beta");
  assert.ok(!(beta.directives || []).some((x) => x.target === "Alpha"));
});

test("@agents cleanup is surfaced to every agent, not auto-handled", async () => {
  await humanText("@agents cleanup", 200, 200);
  assert.ok(
    await until(async () => {
      const { data } = await api("GET", "/diff?agent=Beta");
      return (data.directives || []).some((d) => d.verb === "cleanup");
    }),
  );
  const { data } = await api("GET", "/diff?agent=Alpha");
  assert.ok((data.directives || []).some((d) => d.verb === "cleanup" && d.target === "agents"));
  assert.ok(!data.paused, "cleanup must not pause the host");
});

test("agent-authored @mentions are not directives", async () => {
  await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "text", text: "@Beta look at this", x: 300, y: 300 }],
  });
  await new Promise((r) => setTimeout(r, 400));
  const { data } = await api("GET", "/diff?agent=Beta");
  assert.ok(!(data.directives || []).some((d) => d.text.includes("look at this")));
});

test("@agents pause parks the host: 409 ops, status cards, paused flag; resume lifts it", async () => {
  await humanText("@agents pause", 400, 400);
  assert.ok(
    await until(async () => (await api("GET", "/health")).data && (await api("GET", "/diff?agent=Alpha")).data.paused === true),
    "host should mark itself paused",
  );

  const op = await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "text", text: "should be rejected", x: 1, y: 1 }],
  });
  assert.equal(op.status, 409);
  const cur = await api("POST", "/cursor?agent=Alpha", { x: 0, y: 0 });
  assert.equal(cur.status, 409);

  // status cards were rewritten by the host itself
  const { data: scene } = await api("GET", "/scene");
  const cards = scene.elements.filter((e) => e.kind === "status");
  assert.equal(cards.length, 2);
  for (const c of cards) assert.match(c.text, /paused by board/);

  await humanText("@agents resume", 420, 460);
  assert.ok(
    await until(async () => (await api("GET", "/diff?agent=Alpha")).data.paused !== true),
    "resume directive should lift the pause",
  );
  const op2 = await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "text", text: "accepted again", x: 5, y: 30 }],
  });
  assert.equal(op2.status, 200);
});

test("--on-change fires once per burst, only when nobody is long-polling", async (t) => {
  // drain pending: ack everything for both agents so /wait would block
  for (const agent of ["Alpha", "Beta"]) {
    const { data } = await api("GET", `/diff?agent=${agent}`);
    await api("POST", `/ack?agent=${agent}`, { ids: data.changes.map((c) => c.id) });
  }
  const before = marks().length;

  // burst of 3 human elements with NO waiter -> exactly one spawn
  await humanText("burst 1", 500, 500);
  await humanText("burst 2", 500, 540);
  await humanText("burst 3", 500, 580);
  assert.ok(await until(() => marks().length === before + 1, 5000), "one spawn per burst");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(marks().length, before + 1, "burst must not fork-bomb");

  // with a brain listening, no spawn happens
  await new Promise((r) => setTimeout(r, 1200)); // let the cooldown lapse
  // ack the burst so /wait actually blocks (and registers as a listener)
  const { data: pending } = await api("GET", "/diff?agent=Alpha");
  await api("POST", "/ack?agent=Alpha", { ids: pending.changes.map((c) => c.id) });
  const waitReq = api("GET", "/wait?agent=Alpha&timeout=10");
  await new Promise((r) => setTimeout(r, 200));
  await humanText("while listening", 600, 600);
  const { data: waited } = await waitReq;
  assert.ok(waited.changes.length >= 1, "waiter got the change");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(marks().length, before + 1, "no spawn while a brain was long-polling");
});

test("directive spawns carry WB_TARGET/WB_DIRECTIVE; plain ink spawns unrouted", async () => {
  await new Promise((r) => setTimeout(r, 1200)); // let this host's 1s cooldown lapse
  const before = marks().length;
  await humanText("@Alpha poke holes in the pricing", 700, 100);
  assert.ok(await until(() => marks().length === before + 1, 5000), "directive spawned a brain");
  const routed = JSON.parse(marks()[before]);
  assert.equal(routed.r, "directive");
  assert.equal(routed.t, "Alpha");
  assert.match(routed.d, /poke holes in the pricing/);

  await new Promise((r) => setTimeout(r, 1200));
  await humanText("just a plain note", 700, 200);
  assert.ok(await until(() => marks().length === before + 2, 5000), "plain ink spawned a brain");
  const unrouted = JSON.parse(marks()[before + 1]);
  assert.equal(unrouted.r, "human-change");
  assert.equal(unrouted.t, "", "no target for plain human changes");
  assert.equal(unrouted.d, "");

  await new Promise((r) => setTimeout(r, 1200));
  await humanText("@agents where does this fall apart?", 700, 300);
  assert.ok(await until(() => marks().length === before + 3, 5000), "@agents spawned a brain");
  const all = JSON.parse(marks()[before + 2]);
  assert.equal(all.r, "directive");
  assert.deepEqual(all.t.split(",").sort(), ["Alpha", "Beta"], "@agents targets the whole cast");
});

test("directive spawns bypass the cooldown; human-change spawns respect it", async (t) => {
  // separate host with a long cooldown so bypass vs respect is observable
  const room2 = "phase3-cooldown-room";
  const markFile2 = path.join(stateDir, "cooldown-marks.txt");
  const marks2 = () =>
    fs.existsSync(markFile2) ? fs.readFileSync(markFile2, "utf8").split("\n").filter(Boolean) : [];
  const host2 = spawn(
    process.execPath,
    [
      WB,
      "host",
      "--room",
      `${room2},${ROOM_KEY}`,
      "--agents-json",
      JSON.stringify([{ name: "Solo", slot: 0 }]),
      "--on-change",
      `node -e "require('fs').appendFileSync(process.env.MARK_FILE, JSON.stringify({r:process.env.WB_REASON,t:process.env.WB_TARGET}) + '\\n')"`,
    ],
    {
      env: {
        ...process.env,
        WB_WS_SERVER: relay.url,
        WB_STATE_DIR: stateDir,
        WB_NO_PERSIST: "1",
        WB_DEBOUNCE_MS: "100",
        WB_SPAWN_COOLDOWN: "60",
        MARK_FILE: markFile2,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => host2.kill());
  let port2;
  assert.ok(
    await until(async () => {
      try {
        port2 = JSON.parse(
          fs.readFileSync(path.join(stateDir, room2, "room.json"), "utf8"),
        ).port;
        return (await fetch(`http://127.0.0.1:${port2}/health`)).ok;
      } catch {
        return false;
      }
    }, 15_000),
    "cooldown host came up",
  );
  const human2 = new ExcalidrawClient({ roomId: room2, roomKey: ROOM_KEY, username: "human" });
  t.after(() => human2.close());
  await human2.connect();
  let seq = 0;
  const ink = (text) =>
    human2.syncElements([
      {
        id: `h2-${++seq}`,
        type: "text",
        x: seq * 50,
        y: 100,
        width: 100,
        height: 25,
        text,
        originalText: text,
        fontSize: 20,
        version: 1,
        versionNonce: seq,
      },
    ]);

  // first human change spawns immediately (no prior spawn to cool down from)
  await ink("first note");
  assert.ok(await until(() => marks2().length === 1, 5000), "first spawn fired");

  // second human change is held by the 60s cooldown
  await ink("second note");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(marks2().length, 1, "human-change spawn respects the cooldown");

  // a directive cuts through: merged into the queued spawn and fired now
  await ink("@Solo look at this now");
  assert.ok(await until(() => marks2().length === 2, 5000), "directive bypassed the cooldown");
  const d = JSON.parse(marks2()[1]);
  assert.equal(d.r, "directive");
  assert.equal(d.t, "Solo");
});
