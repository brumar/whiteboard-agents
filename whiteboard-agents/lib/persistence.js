// Scene persistence via excalidraw.com's Firestore backend (REST API).
// Scenes live at scenes/{roomId} as { sceneVersion, ciphertext, iv },
// encrypted with the room key — same E2E scheme as the live protocol.
import { webcrypto } from "node:crypto";
import { encryptPayload, decryptPayload } from "./crypto.js";

const FIREBASE_PROJECT = "excalidraw-room-persistence";
const FIREBASE_API_KEY = "AIzaSyAd15pYlMci_xIp9ko6wkEsDzAAA0Dn0RU"; // public web config
const BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

export function getSceneVersion(elements) {
  return elements.reduce((acc, el) => acc + (el.version || 0), 0);
}

export async function loadScene(roomId, roomKey) {
  const res = await fetch(`${BASE}/scenes/${roomId}?key=${FIREBASE_API_KEY}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore load failed: ${res.status} ${await res.text()}`);
  const doc = await res.json();
  const ciphertext = Buffer.from(doc.fields.ciphertext.bytesValue, "base64");
  const iv = Buffer.from(doc.fields.iv.bytesValue, "base64");
  const elements = await decryptPayload(roomKey, ciphertext, iv);
  return {
    elements,
    sceneVersion: Number(doc.fields.sceneVersion?.integerValue ?? 0),
    updateTime: doc.updateTime,
  };
}

export async function saveScene(roomId, roomKey, elements) {
  const { encryptedBuffer, iv } = await encryptPayload(roomKey, JSON.stringify(elements));
  const body = {
    fields: {
      sceneVersion: { integerValue: String(getSceneVersion(elements)) },
      ciphertext: { bytesValue: Buffer.from(encryptedBuffer).toString("base64") },
      iv: { bytesValue: Buffer.from(iv).toString("base64") },
    },
  };
  const res = await fetch(`${BASE}/scenes/${roomId}?key=${FIREBASE_API_KEY}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Firestore save failed: ${res.status} ${await res.text()}`);
  return getSceneVersion(elements);
}

// Merge-save: load remote, reconcile with ours (higher version wins), save union.
export async function mergeSaveScene(roomId, roomKey, localElements) {
  let remote = null;
  try {
    remote = await loadScene(roomId, roomKey);
  } catch {
    // proceed with local-only save
  }
  const merged = new Map();
  for (const el of remote?.elements || []) if (el?.id) merged.set(el.id, el);
  for (const el of localElements) {
    if (!el?.id) continue;
    const prev = merged.get(el.id);
    if (!prev || el.version > prev.version) merged.set(el.id, el);
  }
  const elements = [...merged.values()];
  await saveScene(roomId, roomKey, elements);
  return elements;
}

export function randomId(bytes = 16) {
  const arr = webcrypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(arr).toString("base64url");
}
