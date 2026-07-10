// Phase 1 behaviors: debounced event-driven /wait, idle presence throttle,
// token-lean responses (presence, ?fields=, ?since= + sceneVersion).
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

const ROOM_ID = "phase1-test-room";
const ROOM_KEY = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-p1-"));

let daemonProc;
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
  daemonProc = spawn(
    process.execPath,
    [WB, "daemon", "--room", `${ROOM_ID},${ROOM_KEY}`, "--agent", "Tester", "--slot", "0"],
    {
      env: {
        ...process.env,
        WB_WS_SERVER: relay.url,
        WB_STATE_DIR: stateDir,
        WB_NO_PERSIST: "1",
        WB_DEBOUNCE_MS: "100",
        WB_DRIFT_MS: "250",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const infoPath = path.join(stateDir, ROOM_ID, "Tester.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(infoPath)) {
      try {
        port = JSON.parse(fs.readFileSync(infoPath, "utf8")).port;
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("daemon did not come up against the fixture");
});

test.after(async () => {
  daemonProc?.kill();
  await relay.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// order matters: silence is asserted before any human presence is signalled

test("idle throttle: no cursor frames while no human is present", async (t) => {
  const observer = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "🤖 obs" });
  t.after(() => observer.close());
  await observer.connect();
  let frames = 0;
  observer.on("pointer", () => frames++);
  // give the drift gate time to park the loop, then observe a quiet second
  await new Promise((r) => setTimeout(r, 700));
  frames = 0;
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(frames, 0, "daemon should not stream cursor frames to an empty room");
  const { data } = await api("GET", "/diff");
  assert.equal(data.humans, false);
});

test("responses carry sceneVersion and presence instead of recentPointers", async () => {
  const { data } = await api("GET", "/diff");
  assert.equal(typeof data.sceneVersion, "number");
  assert.ok(Array.isArray(data.presence));
  assert.ok(!("recentPointers" in data), "recentPointers was dropped in favor of presence");
});

test("debounced wake: /wait resolves ~debounce after a change, not at the 10s tick", async (t) => {
  const human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  t.after(() => human.close());
  await human.connect();

  const t0 = Date.now();
  const waiting = api("GET", "/wait?timeout=20");
  await new Promise((r) => setTimeout(r, 200)); // let the waiter register
  await human.syncElements([
    { id: "h-wake", type: "rectangle", x: 0, y: 0, width: 5, height: 5, version: 1, versionNonce: 1 },
  ]);
  const { data } = await waiting;
  const elapsed = Date.now() - t0;
  assert.equal(data.changes.length, 1);
  assert.equal(data.changes[0].id, "h-wake");
  assert.ok(elapsed < 3000, `resolved in ${elapsed}ms — should beat the 10s tick`);
});

test("human presence wakes the cursor and shows up in presence", async (t) => {
  const human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  const observer = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "🤖 obs" });
  t.after(() => {
    human.close();
    observer.close();
  });
  await human.connect();
  await observer.connect();

  let frames = 0;
  observer.on("pointer", (p) => {
    if (p.username === "🤖 Tester") frames++;
  });
  // human signals presence; volatile frames may drop, so repeat
  const iv = setInterval(() => human.sendCursor(300, 300), 150);
  t.after(() => clearInterval(iv));

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && frames === 0) await new Promise((r) => setTimeout(r, 100));
  clearInterval(iv);
  assert.ok(frames > 0, "idle drift should resume once a human is present");

  const { data } = await api("GET", "/diff");
  assert.equal(data.humans, true);
  const entry = data.presence.find((p) => p.name === "human");
  assert.ok(entry, "presence should list the human");
  assert.equal(entry.x, 300);
  assert.equal(typeof entry.ageSec, "number");
});

test("scene ?fields= projection trims summaries", async () => {
  await api("POST", "/op", { ops: [{ op: "text", text: "projected", x: 50, y: 50 }] });
  const { data } = await api("GET", "/scene?fields=id,author");
  assert.ok(data.elements.length >= 1);
  for (const el of data.elements) {
    assert.deepEqual(Object.keys(el).sort(), ["author", "id"]);
  }
});

test("diff ?since=<sceneVersion> answers tiny when nothing changed", async () => {
  const { data: base } = await api("GET", "/diff");
  const { data } = await api("GET", `/diff?since=${base.sceneVersion}`);
  assert.deepEqual(data.changes, []);
  assert.equal(data.sceneVersion, base.sceneVersion);
  // stale cursor still gets the real diff
  const { data: stale } = await api("GET", `/diff?since=${base.sceneVersion - 1}`);
  assert.ok(Array.isArray(stale.changes));
});
