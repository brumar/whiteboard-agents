import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { parseRoomLink, encryptPayload, decryptPayload } from "../lib/crypto.js";

// A valid 128-bit AES-GCM JWK `k` segment (base64url, 16 bytes).
const KEY = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");

test("parseRoomLink accepts a full excalidraw link", () => {
  const { roomId, roomKey } = parseRoomLink("https://excalidraw.com/#room=abc123DEF,k-ey_42");
  assert.equal(roomId, "abc123DEF");
  assert.equal(roomKey, "k-ey_42");
});

test("parseRoomLink accepts a bare id,key pair (with whitespace)", () => {
  const { roomId, roomKey } = parseRoomLink(" abc123 , key456 ");
  assert.equal(roomId, "abc123");
  assert.equal(roomKey, "key456");
});

test("parseRoomLink rejects garbage", () => {
  assert.throws(() => parseRoomLink("not a room link"), /Cannot parse room link/);
});

test("encrypt/decrypt round-trips JSON payloads", async () => {
  const payload = { type: "SCENE_UPDATE", payload: { elements: [{ id: "x", version: 3 }] } };
  const { encryptedBuffer, iv } = await encryptPayload(KEY, JSON.stringify(payload));
  const decrypted = await decryptPayload(KEY, encryptedBuffer, iv);
  assert.deepEqual(decrypted, payload);
});

test("IV is 12 bytes and unique per encryption", async () => {
  const a = await encryptPayload(KEY, '"x"');
  const b = await encryptPayload(KEY, '"x"');
  assert.equal(a.iv.length, 12);
  assert.equal(b.iv.length, 12);
  assert.notDeepEqual([...a.iv], [...b.iv]);
});

test("tampered ciphertext fails GCM authentication", async () => {
  const { encryptedBuffer, iv } = await encryptPayload(KEY, '{"secret":true}');
  const tampered = new Uint8Array(encryptedBuffer);
  tampered[0] ^= 0xff;
  await assert.rejects(decryptPayload(KEY, tampered, iv));
});

test("wrong key fails decryption", async () => {
  const otherKey = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const { encryptedBuffer, iv } = await encryptPayload(KEY, '{"secret":true}');
  await assert.rejects(decryptPayload(otherKey, encryptedBuffer, iv));
});
