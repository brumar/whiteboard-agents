#!/usr/bin/env node
// Render the board to a PNG entirely offline:
// prefer a live room host's warm renderer (/render), else scene from a live
// host or Firestore -> one-shot excalidraw renderer -> screenshot.
// Usage: node bin/render.js <room-link> [out.png] [--crop content|frame:<id>] [--agent <name>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoomLink } from "../lib/crypto.js";
import { loadScene } from "../lib/persistence.js";
import { createRenderer } from "../lib/render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");

const [, , link, outArg, ...rest] = process.argv;
if (!link) {
  console.error("usage: node bin/render.js <room-link> [out.png] [--crop <c>] [--agent <name>]");
  process.exit(1);
}
const out = outArg && !outArg.startsWith("--") ? outArg : "board.png";
const args = {};
const restAll = [outArg, ...rest].filter(Boolean);
for (let i = 0; i < restAll.length; i++) {
  if (restAll[i]?.startsWith("--")) args[restAll[i].slice(2)] = restAll[i + 1];
}

const { roomId, roomKey } = parseRoomLink(link);
const stateDir = process.env.WB_STATE_DIR || path.join(PKG_ROOT, ".wb");
const roomDir = path.join(stateDir, roomId);

const infoFiles = [];
if (fs.existsSync(path.join(roomDir, "room.json"))) infoFiles.push(path.join(roomDir, "room.json"));
if (fs.existsSync(roomDir)) {
  for (const f of fs.readdirSync(roomDir)) {
    if (f.endsWith(".json") && !f.endsWith(".seen.json") && f !== "room.json") {
      if (args.agent && f !== `${args.agent}.json`) continue;
      infoFiles.push(path.join(roomDir, f));
    }
  }
}

// 1. best path: a live host's warm renderer
for (const f of infoFiles) {
  try {
    const info = JSON.parse(fs.readFileSync(f, "utf8"));
    const q = args.crop ? `?crop=${encodeURIComponent(args.crop)}` : "";
    const res = await fetch(`http://127.0.0.1:${info.port}/render${q}`);
    if (res.ok) {
      fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      console.error(`rendered ${res.headers.get("x-rendered-elements")} elements (warm host)`);
      console.log(out);
      process.exit(0);
    }
  } catch {}
}

// 2. get elements: a running host's live state, else Firestore
let elements = null;
for (const f of infoFiles) {
  try {
    const info = JSON.parse(fs.readFileSync(f, "utf8"));
    const res = await fetch(`http://127.0.0.1:${info.port}/scene?full=1`);
    if (res.ok) {
      elements = (await res.json()).elements;
      console.error(`scene from host on :${info.port}: ${elements.length} elements`);
      break;
    }
  } catch {}
}
if (!elements) {
  const persisted = await loadScene(roomId, roomKey);
  elements = persisted?.elements || [];
  console.error(`scene from firestore: ${elements.length} elements`);
}

// 3. one-shot render through the shared renderer
const renderer = await createRenderer();
const live = elements.filter((e) => !e.isDeleted);
const { png, rendered, restoreError, pageErrors } = await renderer.render(live, {
  crop: args.crop || "content",
  settleMs: 1200, // cold render: fonts/roughjs settle
});
fs.writeFileSync(out, png);
await renderer.close();

console.error(`rendered ${rendered}/${live.length} live elements`);
if (restoreError) console.error(`RESTORE ERROR: ${restoreError}`);
if (pageErrors?.length) console.error(`page errors: ${pageErrors.join(" | ")}`);
console.log(out);
