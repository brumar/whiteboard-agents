// P10 (light bias): anchor-less placement starts its free-space search near
// the freshest human pointer; explicit anchors/coords are untouched; stale or
// agent-only pointers fall back to the old content-edge behavior; `focus` is
// exposed in context payloads.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startRelay } from "./relay-fixture.js";
import { overlaps } from "../lib/elements.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WB = path.join(PKG_ROOT, "bin", "wb.js");

const relay = await startRelay();
process.env.WB_WS_SERVER = relay.url;
const { ExcalidrawClient } = await import("../lib/client.js");

const ROOM_ID = "placement-test-room";
const ROOM_KEY = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-place-"));
const FOCUS_TTL_MS = 1500;
const POINTER = { x: 2000, y: 1500 }; // far from any content

let hostProc;
let port;
let human;

const api = async (method, pathname, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

const until = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const fullScene = async () => (await api("GET", "/scene?full=1")).data.elements;

const pointAndWait = async (x, y) => {
  await human.sendCursor(x, y);
  assert.ok(
    await until(async () => {
      const { data } = await api("GET", "/diff?agent=Placer");
      return data.focus && data.focus.x === Math.round(x);
    }),
    "host should register the human pointer as focus",
  );
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
      JSON.stringify([{ name: "Placer", slot: 0 }, { name: "Sidekick", slot: 1 }]),
    ],
    {
      env: {
        ...process.env,
        WB_WS_SERVER: relay.url,
        WB_STATE_DIR: stateDir,
        WB_NO_PERSIST: "1",
        WB_DEBOUNCE_MS: "100",
        WB_FOCUS_TTL_MS: String(FOCUS_TTL_MS),
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

test("anchor-less ink lands near the fresh human pointer, without overlapping", async () => {
  await pointAndWait(POINTER.x, POINTER.y);
  const { data: first } = await api("POST", "/op?agent=Placer", {
    ops: [{ op: "note", text: "near you" }],
  });
  assert.ok(first.ids?.length, "note op returned ids");
  const a = (await fullScene()).find((e) => e.id === first.ids[0]);
  // empty board: the spiral's start point is free, so placement is exact
  assert.equal(a.x, POINTER.x + 60);
  assert.equal(a.y, POINTER.y + 40);

  await pointAndWait(POINTER.x, POINTER.y); // refresh: the visit animation ate ~1s
  const { data: second } = await api("POST", "/op?agent=Placer", {
    ops: [{ op: "note", text: "also near you" }],
  });
  const b = (await fullScene()).find((e) => e.id === second.ids[0]);
  const boxA = { x: a.x, y: a.y, w: a.width, h: a.height };
  const boxB = { x: b.x, y: b.y, w: b.width, h: b.height };
  assert.ok(!overlaps(boxA, boxB, 0), "second note must not overlap the first");
  const dist = Math.hypot(b.x - (POINTER.x + 60), b.y - (POINTER.y + 40));
  assert.ok(dist <= 500, `second note stays in the pointer's neighborhood (got ${dist})`);
});

test("explicit coordinates and --near anchors are never altered by focus", async () => {
  await pointAndWait(POINTER.x, POINTER.y);
  const { data: fixed } = await api("POST", "/op?agent=Placer", {
    ops: [{ op: "note", text: "pinned", x: -900, y: -900 }],
  });
  const el = (await fullScene()).find((e) => e.id === fixed.ids[0]);
  assert.equal(el.x, -900);
  assert.equal(el.y, -900);

  const { data: anchored } = await api("POST", "/op?agent=Placer", {
    ops: [{ op: "note", text: "anchored", near: fixed.ids[0] }],
  });
  const near = (await fullScene()).find((e) => e.id === anchored.ids[0]);
  const anchor = (await fullScene()).find((e) => e.id === fixed.ids[0]);
  const startX = anchor.x + anchor.width + 40;
  const dist = Math.hypot(near.x - startX, near.y - anchor.y);
  assert.ok(dist <= 500, "anchored ink follows the anchor, not the pointer");
});

test("a stale pointer falls back to content-edge placement, and focus leaves the context", async () => {
  await new Promise((r) => setTimeout(r, FOCUS_TTL_MS + 300));
  const { data: ctx } = await api("GET", "/diff?agent=Placer");
  assert.equal(ctx.focus, undefined, "stale pointer must not surface as focus");
  // presence outlives focus: the human is still listed as present
  assert.ok(ctx.presence.some((p) => p.name === "human"));

  const els = (await fullScene()).filter((e) => !e.isDeleted && e.type !== "frame");
  const maxX = Math.max(...els.map((e) => e.x + (e.width || 0)));
  const { data } = await api("POST", "/op?agent=Placer", {
    ops: [{ op: "note", text: "old behavior" }],
  });
  const el = (await fullScene()).find((e) => e.id === data.ids[0]);
  assert.equal(el.x, maxX + 80, "anchor-less placement reverts to the content edge");
});

test("agent cursors never count as focus", async () => {
  // Sidekick's cursor broadcasts DO reach the primary socket and register it
  // as a fresh peer — but 🤖 names are not humans, so focus stays empty
  await api("POST", "/cursor?agent=Sidekick", { x: 50, y: 50, ms: 100 });
  assert.ok(
    await until(async () => {
      const { data } = await api("GET", "/diff?agent=Placer");
      return data.presence.some((p) => p.name === "🤖 Sidekick" && p.x != null);
    }),
    "the sibling agent's cursor is seen as a peer",
  );
  const { data } = await api("GET", "/diff?agent=Placer");
  assert.equal(data.focus, undefined, "agent pointers must not become focus");
});

test("focus appears in context with integer coords and ageSec", async () => {
  await pointAndWait(123.7, 456.2);
  const { data } = await api("GET", "/diff?agent=Placer");
  assert.deepEqual(
    { x: data.focus.x, y: data.focus.y },
    { x: 124, y: 456 },
    "pointer coords are rounded integers",
  );
  assert.ok(Number.isInteger(data.focus.ageSec) && data.focus.ageSec <= 2);
});
