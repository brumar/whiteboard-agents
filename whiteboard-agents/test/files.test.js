// P4 (agents see images): the compressData envelope round-trips offline, the
// committed fixture decodes byte-exactly, and the host surfaces images —
// hasImage/fileId in summaries, prefetch into the disk cache, GET /file with
// decrypted bytes, clean 404/400 on misses and hostile ids.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startRelay } from "./relay-fixture.js";
import { encodeFileBlob, decodeFileBlob, createFileStore } from "../lib/files.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WB = path.join(PKG_ROOT, "bin", "wb.js");
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(PKG_ROOT, "test", "fixtures", "room-file.json"), "utf8"),
);
const FIXTURE_BLOB = fs.readFileSync(path.join(PKG_ROOT, "test", "fixtures", "room-file.bin"));

const relay = await startRelay();
process.env.WB_WS_SERVER = relay.url;
const { ExcalidrawClient } = await import("../lib/client.js");

const ROOM_ID = "files-test-room";
const ROOM_KEY = FIXTURE.roomKey; // host must decrypt the committed fixture
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-files-"));

// ---- Firebase Storage stub: serves the fixture blob on the excalidraw path --
const storageHits = [];
const storage = http.createServer((req, res) => {
  storageHits.push(req.url);
  const m = req.url.match(/^\/([^?]+)\?alt=media$/);
  const key = m ? decodeURIComponent(m[1]) : null;
  if (key === `files/rooms/${ROOM_ID}/${FIXTURE.fileId}`) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(FIXTURE_BLOB);
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: 404 } }));
});
await new Promise((r) => storage.listen(0, "127.0.0.1", r));
const storageBase = `http://127.0.0.1:${storage.address().port}`;

let hostProc;
let port;
let human;

const api = async (method, pathname, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, raw: res };
};

const until = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

test.before(async () => {
  hostProc = spawn(
    process.execPath,
    [
      WB,
      "host",
      "--room",
      `${ROOM_ID},${ROOM_KEY}`,
      "--agents-json",
      JSON.stringify([{ name: "Looker", slot: 0 }]),
    ],
    {
      env: {
        ...process.env,
        WB_WS_SERVER: relay.url,
        WB_STATE_DIR: stateDir,
        WB_NO_PERSIST: "1",
        WB_DEBOUNCE_MS: "100",
        WB_STORAGE_BASE: storageBase,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const roomInfoPath = path.join(stateDir, ROOM_ID, "room.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      port = JSON.parse(fs.readFileSync(roomInfoPath, "utf8")).port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!port) throw new Error("host did not come up");
  human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  await human.connect();
});

test.after(async () => {
  human?.close();
  hostProc?.kill();
  await relay.close();
  await new Promise((r) => storage.close(r));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("encode → decode round-trips bytes, mime type and metadata", async () => {
  const key = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const bytes = webcrypto.getRandomValues(new Uint8Array(1024));
  const blob = await encodeFileBlob(key, {
    id: "roundtrip-file",
    mimeType: "image/jpeg",
    bytes,
    created: 1111,
  });
  const decoded = await decodeFileBlob(key, blob);
  assert.equal(decoded.mimeType, "image/jpeg");
  assert.deepEqual([...decoded.bytes], [...bytes]);
  assert.equal(decoded.metadata.id, "roundtrip-file");
  assert.equal(decoded.metadata.created, 1111);
  assert.match(decoded.dataURL, /^data:image\/jpeg;base64,/);
});

test("the committed fixture decodes byte-exactly (envelope regression guard)", async () => {
  const decoded = await decodeFileBlob(FIXTURE.roomKey, FIXTURE_BLOB);
  assert.equal(decoded.mimeType, "image/png");
  assert.equal(Buffer.from(decoded.bytes).toString("base64"), FIXTURE.pngBase64);
  assert.equal(decoded.metadata.id, FIXTURE.fileId);
  assert.equal(decoded.metadata.created, FIXTURE.created);
});

test("a wrong room key fails loudly, not with garbage bytes", async () => {
  const wrongKey = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString(
    "base64url",
  );
  await assert.rejects(() => decodeFileBlob(wrongKey, FIXTURE_BLOB));
});

test("human image elements surface hasImage + fileId and are prefetched to disk", async () => {
  await human.syncElements([
    {
      id: "img-1",
      type: "image",
      x: 100,
      y: 100,
      width: 8,
      height: 8,
      fileId: FIXTURE.fileId,
      status: "saved",
      scale: [1, 1],
      version: 1,
      versionNonce: 1,
    },
  ]);
  assert.ok(
    await until(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/diff?agent=Looker`);
      const { changes } = await res.json();
      return changes.some((c) => c.id === "img-1" && c.hasImage && c.fileId === FIXTURE.fileId);
    }),
    "diff summary flags the image",
  );
  const cachePath = path.join(stateDir, ROOM_ID, "files", FIXTURE.fileId);
  assert.ok(
    await until(() => fs.existsSync(cachePath)),
    "prefetch wrote the encrypted blob to the disk cache",
  );
  assert.ok(storageHits.length >= 1, "prefetch actually hit storage");
});

test("GET /file returns decrypted bytes with the right content type", async () => {
  const { status, headers, raw } = await api("GET", `/file?id=${FIXTURE.fileId}`);
  assert.equal(status, 200);
  assert.equal(headers.get("content-type"), "image/png");
  const body = Buffer.from(await raw.arrayBuffer());
  assert.equal(body.toString("base64"), FIXTURE.pngBase64);
});

test("GET /file: 404 with a clear error for unknown ids, 400 for hostile ids", async () => {
  const missing = await api("GET", "/file?id=doesnotexist0000000000000000000000000000");
  assert.equal(missing.status, 404);
  assert.match((await missing.raw.json()).error, /not in room storage/);

  const hostile = await api("GET", `/file?id=${encodeURIComponent("../room.key")}`);
  assert.equal(hostile.status, 400);
  assert.match((await hostile.raw.json()).error, /invalid file id/);

  const none = await api("GET", "/file");
  assert.equal(none.status, 400);
});

test("the file store serves repeats from cache without re-fetching storage", async () => {
  const before = storageHits.length;
  const r1 = await api("GET", `/file?id=${FIXTURE.fileId}`);
  assert.equal(r1.status, 200);
  await r1.raw.arrayBuffer();
  assert.equal(storageHits.length, before, "cached file must not re-hit storage");

  // a cold store (fresh process state) still avoids the network via disk
  const store = createFileStore({
    roomId: ROOM_ID,
    roomKey: ROOM_KEY,
    dir: path.join(stateDir, ROOM_ID, "files"),
  });
  const decoded = await store.load(FIXTURE.fileId);
  assert.equal(Buffer.from(decoded.bytes).toString("base64"), FIXTURE.pngBase64);
  assert.equal(storageHits.length, before, "disk cache satisfied the cold load");
});
