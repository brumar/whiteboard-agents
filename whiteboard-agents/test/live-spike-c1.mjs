// Spike C1 (live, opt-in — talks to excalidraw.com prod infra):
// verify the room-file pipeline against the *deployed* excalidraw encoder,
// not just the npm package's source. Drives a real excalidraw.com tab in
// headless Chromium, drops a PNG onto a throwaway room, waits for the app to
// upload it to Firebase Storage, then fetches + decrypts the blob with
// lib/files.js and compares bytes.
//   node test/live-spike-c1.mjs
// Prints PASS/FAIL per assumption. Creates one throwaway room + one ~300B
// blob on excalidraw's storage (same footprint as any human paste).
import fs from "node:fs";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { ExcalidrawClient } from "../lib/client.js";
import { fetchFileBlob, decodeFileBlob } from "../lib/files.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROMIUM_PATH = process.env.WB_CHROMIUM || "/opt/pw-browsers/chromium";

const roomId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(10))).toString("hex");
const roomKey = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const link = `https://excalidraw.com/#room=${roomId},${roomKey}`;
console.log(`throwaway room: ${roomId}`);

const png = Buffer.from(
  JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "test", "fixtures", "room-file.json"), "utf8"))
    .pngBase64,
  "base64",
);

const results = [];
const report = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// our headless client joins first: it will receive the image element (and its
// fileId) exactly the way the room host does
const watcher = new ExcalidrawClient({ roomId, roomKey, username: "spike-watcher" });
const imageElement = new Promise((resolve) => {
  watcher.on("scene-changed", (els) => {
    const img = els.find((e) => e.type === "image" && e.fileId && !e.isDeleted);
    if (img) resolve(img);
  });
});
await watcher.connect();
report("headless client joined the live room", true);

// in proxied sandboxes Chromium must be told about the egress proxy explicitly
// (the CA is already in the NSS store; never disable TLS verification)
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  executablePath: CHROMIUM_PATH,
  args: ["--no-sandbox"],
  ...(proxy ? { proxy: { server: proxy, bypass: "127.0.0.1,localhost" } } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(link, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector("canvas", { timeout: 60_000 });
  await page.waitForTimeout(3000); // let the app finish joining the room
  report("excalidraw.com loaded and joined the room", true);

  // drop the PNG onto the canvas like a human would
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "spike.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const target = document.querySelector(".excalidraw") || document.body;
    target.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: 640,
        clientY: 400,
        dataTransfer: dt,
      }),
    );
  }, png.toString("base64"));

  const img = await Promise.race([
    imageElement,
    new Promise((_, rej) => setTimeout(() => rej(new Error("no image element within 30s")), 30_000)),
  ]);
  report("image element broadcast with a fileId", true, `fileId ${img.fileId}`);

  // the app uploads on its sync cadence; poll storage until the blob exists
  let blob = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !blob) {
    try {
      blob = await fetchFileBlob(roomId, img.fileId);
    } catch (err) {
      if (err.status !== 404) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  report("encrypted blob appeared in Firebase Storage", !!blob, blob ? `${blob.byteLength} bytes` : "timed out");

  if (blob) {
    const decoded = await decodeFileBlob(roomKey, blob);
    const byteExact = Buffer.from(decoded.bytes).equals(png);
    report(
      "lib/files.js decodes the deployed encoder's envelope",
      decoded.mimeType === "image/png" && decoded.bytes.length > 0,
      `mime ${decoded.mimeType}, id ${decoded.metadata?.id}`,
    );
    // excalidraw may normalize/re-encode the image on paste; byte-exactness is
    // informative, PNG-decodability is the requirement
    console.log(`      (bytes identical to the dropped file: ${byteExact})`);
    const sig = Buffer.from(decoded.bytes.slice(1, 4)).toString();
    report("decoded payload is a PNG", sig === "PNG", `signature ${sig}`);
  }
} finally {
  await browser.close().catch(() => {});
  watcher.close();
}

console.log(results.every(Boolean) ? "\nSPIKE C1: ALL PASS" : "\nSPIKE C1: FAILURES ABOVE");
process.exit(results.every(Boolean) ? 0 : 1);
