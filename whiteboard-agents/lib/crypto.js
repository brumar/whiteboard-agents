// AES-GCM room encryption, wire-compatible with excalidraw's
// packages/excalidraw/data/encryption.ts (128-bit key from the JWK `k`
// segment of the room link, 12-byte IV).
import { webcrypto } from "node:crypto";

const IV_LENGTH_BYTES = 12;

export function parseRoomLink(link) {
  // Accepts a full link (https://excalidraw.com/#room=<id>,<key>)
  // or a bare "<id>,<key>" pair.
  const m = String(link).match(/room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)/);
  if (m) return { roomId: m[1], roomKey: m[2] };
  const parts = String(link).split(",");
  if (parts.length === 2) return { roomId: parts[0].trim(), roomKey: parts[1].trim() };
  throw new Error(`Cannot parse room link: ${link}`);
}

function importKey(roomKey, usage) {
  return webcrypto.subtle.importKey(
    "jwk",
    { alg: "A128GCM", ext: true, k: roomKey, key_ops: ["encrypt", "decrypt"], kty: "oct" },
    { name: "AES-GCM", length: 128 },
    false,
    [usage],
  );
}

export async function encryptPayload(roomKey, data) {
  const key = await importKey(roomKey, "encrypt");
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const encoded = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const encryptedBuffer = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return { encryptedBuffer, iv };
}

export async function decryptBytes(roomKey, encrypted, iv) {
  const key = await importKey(roomKey, "decrypt");
  const buf = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: toUint8(iv) },
    key,
    toUint8(encrypted),
  );
  return new Uint8Array(buf);
}

export async function decryptPayload(roomKey, encrypted, iv) {
  const bytes = await decryptBytes(roomKey, encrypted, iv);
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

function toUint8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (Buffer.isBuffer(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new Error(`Cannot coerce to Uint8Array: ${typeof x}`);
}
