// Open the live room in headless Chromium and screenshot it — lets an agent
// (or a human away from the board) see exactly what a real client renders.
import { chromium } from "playwright-core";

const link = process.argv[2];
const out = process.argv[3] || "board.png";
if (!link) {
  console.error("usage: node bin/snapshot.js <room-link> [out.png] [--stay <seconds>]");
  process.exit(1);
}
const stayIdx = process.argv.indexOf("--stay");
const staySeconds = stayIdx > 0 ? Number(process.argv[stayIdx + 1] || 0) : 0;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true, // the sandbox proxy re-signs TLS
});
await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 });
// give collab time to connect and receive the scene
await page.waitForTimeout(8000);
// zoom to fit content if the canvas shortcut is available
await page.keyboard.press("Shift+1").catch(() => {});
await page.waitForTimeout(1500);
if (staySeconds) await page.waitForTimeout(staySeconds * 1000);
await page.screenshot({ path: out });
console.log(`saved ${out}`);
await browser.close();
