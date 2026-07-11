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
// produces. Used by tests and fixtures; agents don't upload files (yet).
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
  };
}
