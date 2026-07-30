// Room files (P4): images and other binaries pasted onto a board live in
// excalidraw's Firebase Storage at files/rooms/<roomId>/<fileId>, encrypted
// with the room key inside the `compressData` envelope of excalidraw's
// data/encode.ts (byte layout pinned from the sourcemap shipped with
// @excalidraw/excalidraw 0.18.1):
//
//   blob  = concat( encodingMetaJSON , iv , ciphertext )
//   plain = inflate( aesGcmDecrypt(ciphertext, roomKey, iv) )   // zlib stream
//   plain = concat( contentsMetaJSON , dataURL-bytes )
//
// where concat() frames its chunks as [u32 version=1][u32 len][bytes]…, all
// big-endian, contentsMeta is {id, mimeType, created, lastRetrieved} and the
// payload is the file's data URL. pako and node:zlib are wire-compatible.
import fs from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { encryptPayload, decryptBytes } from "./crypto.js";

const DEFAULT_STORAGE_BASE =
  "https://firebasestorage.googleapis.com/v0/b/excalidraw-room-persistence.appspot.com/o";
const storageBase = () => process.env.WB_STORAGE_BASE || DEFAULT_STORAGE_BASE;

const CONCAT_VERSION = 1;
const MEM_LIMIT_BYTES = 32 * 1024 * 1024; // decoded-files LRU budget per room
const SAFE_ID = /^[A-Za-z0-9_-]+$/; // fileIds double as cache file names

export function concatBuffers(...buffers) {
  const total = 4 + buffers.reduce((acc, b) => acc + 4 + b.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let cursor = 0;
  view.setUint32(cursor, CONCAT_VERSION);
  cursor += 4;
  for (const b of buffers) {
    view.setUint32(cursor, b.byteLength);
    cursor += 4;
    out.set(b, cursor);
    cursor += b.byteLength;
  }
  return out;
}

export function splitBuffers(buf) {
  const bytes = toU8(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;
  const version = view.getUint32(cursor);
  cursor += 4;
  if (version > CONCAT_VERSION) throw new Error(`unsupported file envelope version ${version}`);
  const chunks = [];
  while (cursor < bytes.byteLength) {
    const len = view.getUint32(cursor);
    cursor += 4;
    chunks.push(bytes.slice(cursor, cursor + len));
    cursor += len;
  }
  return chunks;
}

function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new Error(`cannot coerce to Uint8Array: ${typeof x}`);
}

export function parseDataURL(dataURL) {
  const m = String(dataURL).match(/^data:([^;,]*)?(;base64)?,(.*)$/s);
  if (!m) throw new Error("file payload is not a data URL");
  return {
    mimeType: m[1] || "application/octet-stream",
    bytes: m[2]
      ? new Uint8Array(Buffer.from(m[3], "base64"))
      : new Uint8Array(Buffer.from(decodeURIComponent(m[3]), "utf8")),
  };
}

export async function decodeFileBlob(roomKey, blob) {
  const [encodingMetaBuf, iv, ciphertext] = splitBuffers(blob);
  const encodingMeta = JSON.parse(new TextDecoder().decode(encodingMetaBuf));
  let plain = await decryptBytes(roomKey, ciphertext, iv);
  if (encodingMeta.compression) plain = new Uint8Array(inflateSync(plain));
  const [contentsMetaBuf, contents] = splitBuffers(plain);
  const metadata = JSON.parse(new TextDecoder().decode(contentsMetaBuf));
  const dataURL = new TextDecoder().decode(contents);
  const { mimeType, bytes } = parseDataURL(dataURL);
  return { mimeType: metadata?.mimeType || mimeType, dataURL, bytes, metadata };
}

// Inverse of decodeFileBlob — same envelope excalidraw's encodeFilesForUpload
// produces. Used by the image op, tests and fixtures.
export async function encodeFileBlob(roomKey, { id, mimeType, bytes, created = Date.now() }) {
  const dataURL = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  const metadata = { id, mimeType, created, lastRetrieved: created };
  const plain = concatBuffers(
    new TextEncoder().encode(JSON.stringify(metadata)),
    new TextEncoder().encode(dataURL),
  );
  const { encryptedBuffer, iv } = await encryptPayload(roomKey, new Uint8Array(deflateSync(plain)));
  const encodingMeta = { version: 2, compression: "pako@1", encryption: "AES-GCM" };
  return concatBuffers(
    new TextEncoder().encode(JSON.stringify(encodingMeta)),
    iv,
    new Uint8Array(encryptedBuffer),
  );
}

export async function fetchFileBlob(roomId, fileId) {
  const url = `${storageBase()}/${encodeURIComponent(`files/rooms/${roomId}/${fileId}`)}?alt=media`;
  const res = await fetch(url);
  if (res.status === 404) {
    throw Object.assign(
      new Error(`file ${fileId} not in room storage (pasted but never saved, or foreign room)`),
      { status: 404 },
    );
  }
  if (!res.ok) throw new Error(`file fetch failed: ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Upload an encoded blob where collaborators' excalidraw will look for it —
// the multipart flavor of the Storage REST API, same as the SDK's uploadBytes.
export async function uploadFileBlob(roomId, fileId, blob) {
  const name = `files/rooms/${roomId}/${fileId}`;
  const boundary = "wbfile" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, contentType: "application/octet-stream" });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(blob),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch(`${storageBase()}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      "x-goog-upload-protocol": "multipart",
      "content-type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`file upload failed: ${res.status} ${await res.text()}`);
}

// Pixel dimensions from image headers — enough for png/jpeg/gif/webp, the
// formats worth placing on a board. Returns null when it can't tell.
export function imageSize(bytes) {
  const b = toU8(bytes);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: IHDR width/height at fixed offsets
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF: little-endian logical screen size
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // JPEG: walk segments to the first SOF marker
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      }
      i += 2 + view.getUint16(i + 2);
    }
    return null;
  }
  // WebP (VP8X extended header)
  if (b.length > 30 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    if (b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58) {
      return {
        width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      };
    }
  }
  return null;
}

// Per-room file cache: encrypted blobs on disk (same trust domain as
// room.key), decoded files in a bounded in-memory LRU, deduped in-flight.
export function createFileStore({ roomId, roomKey, dir }) {
  const mem = new Map(); // fileId -> decoded; Map order doubles as LRU order
  let memBytes = 0;
  const pending = new Map(); // fileId -> Promise, so bursts fetch once

  const remember = (fileId, decoded) => {
    mem.set(fileId, decoded);
    memBytes += decoded.bytes.byteLength;
    for (const [id, d] of mem) {
      if (memBytes <= MEM_LIMIT_BYTES || id === fileId) break;
      mem.delete(id);
      memBytes -= d.bytes.byteLength;
    }
  };

  async function loadNow(fileId) {
    const diskPath = path.join(dir, fileId);
    let blob = fs.existsSync(diskPath) ? new Uint8Array(fs.readFileSync(diskPath)) : null;
    if (!blob) {
      blob = await fetchFileBlob(roomId, fileId);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(diskPath, blob);
      } catch {}
    }
    const decoded = await decodeFileBlob(roomKey, blob);
    remember(fileId, decoded);
    return decoded;
  }

  return {
    async load(fileId) {
      if (!SAFE_ID.test(String(fileId))) {
        throw Object.assign(new Error(`invalid file id: ${fileId}`), { status: 400 });
      }
      if (mem.has(fileId)) {
        const d = mem.get(fileId);
        mem.delete(fileId); // re-insert: freshest LRU position
        mem.set(fileId, d);
        return d;
      }
      if (pending.has(fileId)) return pending.get(fileId);
      const p = loadNow(fileId).finally(() => pending.delete(fileId));
      pending.set(fileId, p);
      return p;
    },
    cached: (fileId) =>
      mem.has(fileId) || (SAFE_ID.test(String(fileId)) && fs.existsSync(path.join(dir, fileId))),
    // seed the cache with a blob we produced ourselves (agent image uploads),
    // so /file and /render serve it without a network round-trip
    async store(fileId, blob) {
      if (!SAFE_ID.test(String(fileId))) {
        throw Object.assign(new Error(`invalid file id: ${fileId}`), { status: 400 });
      }
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, fileId), blob);
      } catch {}
      const decoded = await decodeFileBlob(roomKey, blob);
      remember(fileId, decoded);
      return decoded;
    },
  };
}
