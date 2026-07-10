// Render smoke test (not part of `npm test` — needs Chromium):
// host on a local relay fixture -> a few ops -> GET /render -> assert a
// non-blank PNG whose element count matches the live scene.
// Run: npm run test:render
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
const ROOM_ID = "render-smoke-room";
const ROOM_KEY = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-render-"));

const hostProc = spawn(
  process.execPath,
  [WB, "host", "--room", `${ROOM_ID},${ROOM_KEY}`, "--agents-json", JSON.stringify([{ name: "Render" }])],
  {
    env: { ...process.env, WB_WS_SERVER: relay.url, WB_STATE_DIR: stateDir, WB_NO_PERSIST: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  },
);

const fail = async (msg) => {
  console.error(`RENDER SMOKE FAIL: ${msg}`);
  hostProc.kill();
  await relay.close();
  process.exit(1);
};

let port;
{
  const roomInfoPath = path.join(stateDir, ROOM_ID, "room.json");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !port) {
    try {
      port = JSON.parse(fs.readFileSync(roomInfoPath, "utf8")).port;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!port) await fail("host did not come up");
}

const api = (method, pathname, body) =>
  fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

await api("POST", "/op", {
  ops: [
    { op: "note", text: "render smoke", x: 100, y: 100 },
    { op: "shape", shape: "ellipse", x: 400, y: 120, w: 120, h: 80 },
    { op: "text", text: "hello", x: 300, y: 300 },
  ],
});

const t0 = Date.now();
const res = await api("GET", "/render?crop=content");
if (!res.ok) await fail(`GET /render -> ${res.status}: ${await res.text()}`);
const png = Buffer.from(await res.arrayBuffer());
const coldMs = Date.now() - t0;
const rendered = Number(res.headers.get("x-rendered-elements"));

const scene = await (await api("GET", "/scene")).json();
const live = scene.elements.filter((e) => !e.deleted).length;

if (png.length < 10_000) await fail(`PNG suspiciously small (${png.length} bytes) — blank render?`);
if (png.subarray(1, 4).toString() !== "PNG") await fail("not a PNG");
if (rendered !== live) await fail(`rendered ${rendered} != live ${live}`);

// warm renders should be fast (<2s is generous; warm target is ~500ms)
const t1 = Date.now();
const res2 = await api("GET", "/render");
await res2.arrayBuffer();
const warmMs = Date.now() - t1;
if (!res2.ok) await fail(`second render -> ${res2.status}`);

const out = path.join(stateDir, "smoke.png");
fs.writeFileSync(out, png);
console.log(
  `RENDER SMOKE OK: ${rendered}/${live} elements, ${png.length} bytes, cold ${coldMs}ms, warm ${warmMs}ms (${out})`,
);
if (warmMs > 2000) console.warn(`warm render took ${warmMs}ms — expected <2s`);

hostProc.kill();
await relay.close();
process.exit(0);
