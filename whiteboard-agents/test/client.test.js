import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { startRelay } from "./relay-fixture.js";

// WS_SERVER_URL is read at module load; point it at the fixture first.
const relay = await startRelay();
process.env.WB_WS_SERVER = relay.url;
const { ExcalidrawClient } = await import("../lib/client.js");

const ROOM_KEY = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
let roomSeq = 0;
const freshRoom = () => `test-room-${++roomSeq}`;

const once = (emitter, event, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });

test("first client in a room resolves firstInRoom", async (t) => {
  const c = new ExcalidrawClient({ roomId: freshRoom(), roomKey: ROOM_KEY, username: "🤖 A" });
  t.after(() => c.close());
  const res = await c.connect();
  assert.equal(res.firstInRoom, true);
});

test("scene updates propagate, decrypt, and reconcile across clients", async (t) => {
  const roomId = freshRoom();
  const a = new ExcalidrawClient({ roomId, roomKey: ROOM_KEY, username: "🤖 A" });
  const b = new ExcalidrawClient({ roomId, roomKey: ROOM_KEY, username: "🤖 B" });
  t.after(() => {
    a.close();
    b.close();
  });
  await a.connect();
  const bConnected = b.connect();
  // A answers B's join with SCENE_INIT (empty); B resolves as non-first
  const resB = await bConnected;
  assert.equal(resB.firstInRoom, false);

  const el = { id: "el-1", type: "rectangle", x: 1, y: 2, width: 10, height: 10, version: 1, versionNonce: 7 };
  const changed = once(b, "scene-changed");
  await a.syncElements([el]);
  const [els, type] = await changed;
  assert.equal(type, "SCENE_UPDATE");
  assert.equal(els.length, 1);
  assert.deepEqual(b.scene.get("el-1"), el);
});

test("new joiner receives the current scene via SCENE_INIT", async (t) => {
  const roomId = freshRoom();
  const a = new ExcalidrawClient({ roomId, roomKey: ROOM_KEY, username: "🤖 A" });
  t.after(() => a.close());
  await a.connect();
  a.reconcile([{ id: "pre", type: "ellipse", x: 0, y: 0, version: 2, versionNonce: 1 }]);

  const b = new ExcalidrawClient({ roomId, roomKey: ROOM_KEY, username: "human" });
  t.after(() => b.close());
  await b.connect();
  // b resolved from SCENE_INIT, so the element is already there
  assert.ok(b.scene.get("pre"), "joiner should have received the scene");
});

test("MOUSE_LOCATION rides the volatile path and reaches peers", async (t) => {
  const roomId = freshRoom();
  const a = new ExcalidrawClient({ roomId, roomKey: ROOM_KEY, username: "🤖 A" });
  const b = new ExcalidrawClient({ roomId, roomKey: ROOM_KEY, username: "human" });
  t.after(() => {
    a.close();
    b.close();
  });
  await a.connect();
  await b.connect();

  const pointer = once(b, "pointer");
  // volatile frames can drop before the socket is fully ready; retry until seen
  const iv = setInterval(() => a.sendCursor(120, 240), 100);
  t.after(() => clearInterval(iv));
  const [p] = await pointer;
  clearInterval(iv);
  assert.equal(p.username, "🤖 A");
  assert.deepEqual(p.pointer, { x: 120, y: 240, tool: "pointer" });
});

test("idle status reaches peers with username", async (t) => {
  const roomId = freshRoom();
  const a = new ExcalidrawClient({ roomId, roomKey: ROOM_KEY, username: "🤖 A" });
  const b = new ExcalidrawClient({ roomId, roomKey: ROOM_KEY, username: "human" });
  t.after(() => {
    a.close();
    b.close();
  });
  await a.connect();
  await b.connect();
  const status = once(b, "idle-status");
  const iv = setInterval(() => a.sendIdleStatus("active"), 100);
  t.after(() => clearInterval(iv));
  const [s] = await status;
  clearInterval(iv);
  assert.equal(s.userState, "active");
  assert.equal(s.username, "🤖 A");
});

test("collaborator counting tracks joins and leaves", async (t) => {
  const roomId = freshRoom();
  const a = new ExcalidrawClient({ roomId, roomKey: ROOM_KEY, username: "🤖 A" });
  t.after(() => a.close());
  await a.connect();
  assert.equal(a.collaborators.size, 1);

  const b = new ExcalidrawClient({ roomId, roomKey: ROOM_KEY, username: "human" });
  const seenTwo = once(a, "room-user-change");
  await b.connect();
  await seenTwo;
  assert.equal(a.collaborators.size, 2);

  const seenOne = once(a, "room-user-change");
  b.close();
  await seenOne;
  assert.equal(a.collaborators.size, 1);
});

test.after(async () => {
  await relay.close();
});
