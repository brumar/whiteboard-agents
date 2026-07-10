#!/usr/bin/env node
// Render the board to a PNG entirely offline:
// scene (live daemon or Firestore) -> real excalidraw renderer -> screenshot.
// Usage: node bin/render.js <room-link> [out.png] [--source firestore|agent] [--agent <name>]
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { parseRoomLink } from "../lib/crypto.js";
import { loadScene } from "../lib/persistence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");

const [, , link, outArg, ...rest] = process.argv;
if (!link) {
  console.error("usage: node bin/render.js <room-link> [out.png] [--agent <name>]");
  process.exit(1);
}
const out = outArg && !outArg.startsWith("--") ? outArg : "board.png";
const args = {};
const restAll = [outArg, ...rest].filter(Boolean);
for (let i = 0; i < restAll.length; i++) {
  if (restAll[i]?.startsWith("--")) args[restAll[i].slice(2)] = restAll[i + 1];
}

const { roomId, roomKey } = parseRoomLink(link);

// 1. get elements: prefer a running agent daemon (has live state), else Firestore
let elements = null;
const stateDir = process.env.WB_STATE_DIR || path.join(PKG_ROOT, ".wb");
const roomDir = path.join(stateDir, roomId);
if (fs.existsSync(roomDir)) {
  for (const f of fs.readdirSync(roomDir)) {
    if (!f.endsWith(".json") || f.endsWith(".seen.json")) continue;
    if (args.agent && f !== `${args.agent}.json`) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(roomDir, f), "utf8"));
      const res = await fetch(`http://127.0.0.1:${info.port}/scene?full=1`);
      if (res.ok) {
        elements = (await res.json()).elements;
        console.error(`scene from agent ${info.agent}: ${elements.length} elements`);
        break;
      }
    } catch {}
  }
}
if (!elements) {
  const persisted = await loadScene(roomId, roomKey);
  elements = persisted?.elements || [];
  console.error(`scene from firestore: ${elements.length} elements`);
}

// 2. bundle the viewer (cached until app.jsx or the package changes)
const outDir = path.join(PKG_ROOT, ".wb", "viewer");
fs.mkdirSync(outDir, { recursive: true });
const bundlePath = path.join(outDir, "app.js");
const srcPath = path.join(PKG_ROOT, "viewer", "app.jsx");
if (!fs.existsSync(bundlePath) || fs.statSync(bundlePath).mtimeMs < fs.statSync(srcPath).mtimeMs) {
  await build({
    entryPoints: [srcPath],
    bundle: true,
    outfile: bundlePath,
    format: "iife",
    jsx: "automatic",
    conditions: ["production"],
    loader: { ".woff2": "file", ".ttf": "file" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    logLevel: "silent",
  });
  console.error("viewer bundled");
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;

// 3. serve scene + viewer on localhost
const assetRoot = path.join(PKG_ROOT, "node_modules", "@excalidraw", "excalidraw", "dist", "prod");
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/") return res.end(HTML);
  if (url === "/scene.json") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ elements }));
  }
  let file = null;
  if (url === "/app.js") file = bundlePath;
  else if (url.startsWith("/assets/")) file = path.join(assetRoot, url.slice(8));
  else file = path.join(outDir, path.basename(url));
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    if (file.endsWith(".css")) res.setHeader("content-type", "text/css");
    if (file.endsWith(".woff2")) res.setHeader("content-type", "font/woff2");
    return res.end(fs.readFileSync(file));
  }
  res.statusCode = 404;
  res.end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// 4. screenshot
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load", timeout: 30000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1200); // fonts/roughjs settle
const restoreError = await page.evaluate(() => window.__restoreError);
const rendered = await page.evaluate(() => window.__api?.getSceneElements()?.length ?? -1);
await page.screenshot({ path: out });
await browser.close();
server.close();

console.error(`rendered ${rendered}/${elements.filter((e) => !e.isDeleted).length} live elements`);
if (restoreError) console.error(`RESTORE ERROR: ${restoreError}`);
if (errors.length) console.error(`page errors: ${errors.slice(0, 3).join(" | ")}`);
console.log(out);
