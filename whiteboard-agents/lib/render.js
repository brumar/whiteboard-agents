// Warm offline renderer: the real excalidraw renderer in a headless Chromium,
// kept alive between renders so "seeing" the board costs ~300ms, not ~5s.
// Used by the room host's GET /render; bin/render.js uses it one-shot.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROMIUM_PATH = process.env.WB_CHROMIUM || "/opt/pw-browsers/chromium";

const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;

// Bundle the viewer (cached until app.jsx or the excalidraw package changes).
export async function bundleViewer() {
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
  }
  return { outDir, bundlePath };
}

// Serve viewer + assets; `getScene` supplies /scene.json on each request.
export function serveViewer({ outDir, bundlePath, getScene, extraRoutes }) {
  const assetRoot = path.join(PKG_ROOT, "node_modules", "@excalidraw", "excalidraw", "dist", "prod");
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (extraRoutes && extraRoutes(req, res, url)) return;
    if (url === "/") return res.end(HTML);
    if (url === "/scene.json") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ elements: getScene() }));
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
  return server;
}

export async function createRenderer({ viewport = { width: 1600, height: 1000 } } = {}) {
  const { outDir, bundlePath } = await bundleViewer();
  let currentElements = [];
  const server = serveViewer({ outDir, bundlePath, getScene: () => currentElements });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(800); // fonts settle once, at warm-up

  return {
    port,
    async render(elements, { crop = "content", settleMs = 300, files = [] } = {}) {
      currentElements = elements;
      let focusIds = null;
      if (crop.startsWith("frame:")) {
        const frameId = crop.slice("frame:".length);
        focusIds = elements
          .filter((e) => e.id === frameId || e.frameId === frameId)
          .map((e) => e.id);
        if (!focusIds.length) throw Object.assign(new Error(`frame not found: ${frameId}`), { status: 404 });
      }
      const rendered = await page.evaluate(
        ([els, ids, binaryFiles]) => window.__setScene(els, ids, binaryFiles),
        [elements, focusIds, files],
      );
      await page.waitForTimeout(settleMs);
      const png = await page.screenshot();
      const restoreError = await page.evaluate(() => window.__restoreError);
      const filesError = await page.evaluate(() => window.__filesError);
      return { png, rendered, restoreError, filesError, pageErrors: pageErrors.slice(0, 3) };
    },
    async close() {
      await browser.close().catch(() => {});
      server.close();
    },
  };
}
