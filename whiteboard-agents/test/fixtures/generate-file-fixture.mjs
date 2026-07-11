// Regenerates the room-file fixture: a small PNG wrapped in the exact
// compressData envelope excalidraw uploads to Firebase Storage (byte layout
// pinned from @excalidraw/excalidraw 0.18.1's shipped sourcemap — see
// lib/files.js). Run once and commit the outputs; tests decode the committed
// blob so a regression in decodeFileBlob can't hide behind a fresh encode.
//   node test/fixtures/generate-file-fixture.mjs
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { encodeFileBlob } from "../../lib/files.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// minimal 8x8 solid-red RGBA PNG, built by hand so the fixture has no deps
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const W = 8;
const H = 8;
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    raw.set([224, 49, 49, 255], y * (1 + W * 4) + 1 + x * 4);
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const roomKey = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const fileId = "6ff886b31a478f1da6b1fa2e509a8dbea6cca8d8"; // shape of a real fileId (sha1 hex)
const created = 1752192000000; // 2025-07-11, fixed so the fixture is stable

const blob = await encodeFileBlob(roomKey, { id: fileId, mimeType: "image/png", bytes: png, created });

fs.writeFileSync(path.join(HERE, "room-file.bin"), blob);
fs.writeFileSync(
  path.join(HERE, "room-file.json"),
  JSON.stringify(
    { roomKey, fileId, mimeType: "image/png", created, pngBase64: png.toString("base64") },
    null,
    2,
  ),
);
console.log(`wrote room-file.bin (${blob.byteLength} bytes) + room-file.json`);
