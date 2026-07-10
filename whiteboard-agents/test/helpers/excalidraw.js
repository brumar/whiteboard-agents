// Bundles @excalidraw/excalidraw's restoreElements for Node and returns it.
// This is the schema-drift tripwire: element factories are validated through
// excalidraw's own restore path, so a schema change breaks tests, not boards.
import "./dom-shim.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_DIR = path.join(PKG_ROOT, ".wb", "test-cache");
const BUNDLE = path.join(CACHE_DIR, "restore.mjs");

export async function loadRestoreElements() {
  const pkgMeta = path.join(PKG_ROOT, "node_modules", "@excalidraw", "excalidraw", "package.json");
  const stale =
    !fs.existsSync(BUNDLE) || fs.statSync(BUNDLE).mtimeMs < fs.statSync(pkgMeta).mtimeMs;
  if (stale) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    await build({
      stdin: {
        contents: 'export { restoreElements } from "@excalidraw/excalidraw";',
        resolveDir: PKG_ROOT,
        loader: "js",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["production"],
      outfile: BUNDLE,
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
      loader: { ".woff2": "empty", ".ttf": "empty", ".css": "empty" },
      logLevel: "silent",
    });
  }
  const mod = await import(BUNDLE);
  return mod.restoreElements;
}
