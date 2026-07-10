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

const ROOM_ID = "daemon-test-room";
const ROOM_KEY = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-"));

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

test("GET /health reports the daemon's state", async () => {
  const { status, data } = await api("GET", "/health");
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.agent, "Tester");
  assert.equal(data.roomId, ROOM_ID);
  assert.equal(data.connected, true);
});

test("POST /op note inserts elements and returns their ids", async () => {
  const { status, data } = await api("POST", "/op", {
    ops: [{ op: "note", text: "hello from the test", x: 100, y: 100 }],
  });
  assert.equal(status, 200);
  assert.equal(data.ids.length, 2); // container + bound text

  const scene = await api("GET", "/scene");
  const byId = new Map(scene.data.elements.map((e) => [e.id, e]));
  for (const id of data.ids) {
    assert.ok(byId.has(id), `scene should contain ${id}`);
    assert.equal(byId.get(id).author, "Tester");
  }
});

test("own elements are pre-acked: /diff stays empty", async () => {
  const { data } = await api("GET", "/diff");
  assert.deepEqual(data.changes, []);
});

test("foreign elements appear in /diff and /ack clears them", async (t) => {
  const human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  t.after(() => human.close());
  await human.connect();
  const el = {
    id: "human-el-1",
    type: "rectangle",
    x: 400,
    y: 400,
    width: 50,
    height: 50,
    version: 1,
    versionNonce: 3,
  };
  await human.syncElements([el]);

  // wait for the daemon to reconcile the broadcast
  let changes = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    ({ data: { changes } } = await api("GET", "/diff"));
    if (changes.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(changes.length, 1);
  assert.equal(changes[0].id, "human-el-1");
  assert.equal(changes[0].author, "human");

  const ack = await api("POST", "/ack", { ids: ["human-el-1"] });
  assert.equal(ack.data.seen, 1);
  const after = await api("GET", "/diff");
  assert.deepEqual(after.data.changes, []);
});

test("GET /wait times out cleanly when nothing changes", async () => {
  const t0 = Date.now();
  const { status, data } = await api("GET", "/wait?timeout=1");
  assert.equal(status, 200);
  assert.equal(data.timedOut, true);
  assert.deepEqual(data.changes, []);
  assert.ok(Date.now() - t0 >= 950, "should have waited ~1s");
});

test("POST /save is a no-op under WB_NO_PERSIST (degrades gracefully)", async () => {
  const { status, data } = await api("POST", "/save");
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.skipped, true);
});

test("update/delete refuse to touch non-own elements", async () => {
  const upd = await api("POST", "/op", {
    ops: [{ op: "update", id: "human-el-1", props: { x: 0 } }],
  });
  assert.equal(upd.status, 500);
  assert.match(upd.data.error, /refusing/);
  const del = await api("POST", "/op", { ops: [{ op: "delete", id: "human-el-1" }] });
  assert.equal(del.status, 500);
  assert.match(del.data.error, /refusing/);
});

test("unknown routes 404", async () => {
  const { status } = await api("GET", "/nope");
  assert.equal(status, 404);
});
