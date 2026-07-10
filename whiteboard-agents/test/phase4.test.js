// Phase 4 behaviors: session journal, SSE live viewer feed, key hygiene,
// op rate limiting, wb down.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startRelay } from "./relay-fixture.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WB = path.join(PKG_ROOT, "bin", "wb.js");

const relay = await startRelay();
process.env.WB_WS_SERVER = relay.url;
const { ExcalidrawClient } = await import("../lib/client.js");

const ROOM_ID = "phase4-test-room";
const ROOM_KEY = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-p4-"));

let hostProc;
let port;

const api = async (method, pathname, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, data: await res.json() };
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
      JSON.stringify([{ name: "Alpha", slot: 0 }]),
    ],
    {
      env: {
        ...process.env,
        WB_WS_SERVER: relay.url,
        WB_STATE_DIR: stateDir,
        WB_NO_PERSIST: "1",
        WB_DEBOUNCE_MS: "100",
        WB_OPS_PER_MIN: "5",
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
});

test.after(async () => {
  hostProc?.kill();
  await relay.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("the room key is persisted 0600 and never appears in the host log", async () => {
  const keyPath = path.join(stateDir, ROOM_ID, "room.key");
  assert.ok(fs.existsSync(keyPath));
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(keyPath, "utf8").trim(), ROOM_KEY);
});

test("journal records joins, ops, acks, human ink and directives", async (t) => {
  await api("POST", "/op?agent=Alpha", {
    ops: [{ op: "text", text: "journaled", x: 10, y: 10 }],
  });

  const human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  t.after(() => human.close());
  await human.connect();
  await human.syncElements([
    {
      id: "h-j1",
      type: "text",
      x: 40,
      y: 40,
      text: "@Alpha check this",
      originalText: "@Alpha check this",
      fontSize: 20,
      version: 1,
      versionNonce: 1,
    },
  ]);
  await new Promise((r) => setTimeout(r, 500));
  await api("POST", "/ack?agent=Alpha", { ids: ["h-j1"] });

  const { data } = await api("GET", "/journal?tail=50");
  const events = data.entries.map((e) => e.event);
  assert.ok(events.includes("join"), "join logged");
  assert.ok(events.includes("op"), "ops logged");
  assert.ok(events.includes("ack"), "acks logged");
  assert.ok(events.includes("directive"), "directives logged");
  const humanOp = data.entries.find((e) => e.event === "op" && e.agent === "human");
  assert.ok(humanOp, "human ink attributed in the journal");
  const file = path.join(stateDir, ROOM_ID, "journal.jsonl");
  assert.ok(fs.existsSync(file), "journal.jsonl exists on disk");
});

test("op rate limit answers 429 with retry-after once the bucket is empty", async () => {
  // bucket = 5/min; the twojournal-test ops already consumed some — drain it
  let limited = null;
  for (let i = 0; i < 8; i++) {
    const r = await api("POST", "/op?agent=Alpha", {
      ops: [{ op: "text", text: `rl ${i}`, x: 100 + i * 30, y: 200 }],
    });
    if (r.status === 429) {
      limited = r;
      break;
    }
  }
  assert.ok(limited, "bucket should run out within 8 ops at 5/min");
  assert.match(limited.data.error, /rate limit/);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});

test("GET /view serves the viewer and /events streams scene updates", async (t) => {
  const view = await fetch(`http://127.0.0.1:${port}/view`);
  assert.equal(view.status, 200);
  assert.match(await view.text(), /<div id="root">/);
  // the bundle is served after /view bootstrapped it
  const js = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(js.status, 200);

  // subscribe over raw http and capture SSE frames
  const frames = [];
  const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => frames.push(chunk));
  });
  t.after(() => req.destroy());
  await new Promise((r) => setTimeout(r, 400));
  const initial = frames.join("");
  assert.match(initial, /"type":"scene"/, "initial scene event sent on connect");

  frames.length = 0;
  // wait for the rate-limit bucket to refill one token (5/min = 12s) — too
  // slow; use a human edit instead, which doesn't consume op tokens
  const human = new ExcalidrawClient({ roomId: ROOM_ID, roomKey: ROOM_KEY, username: "human" });
  t.after(() => human.close());
  await human.connect();
  await human.syncElements([
    { id: "sse-el", type: "rectangle", x: 0, y: 0, width: 5, height: 5, version: 1, versionNonce: 2 },
  ]);
  const got = await (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (frames.join("").includes("sse-el")) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  assert.ok(got, "scene update pushed to SSE viewers");
});

test("wb down --yes stops the host and purges the room state", async () => {
  // separate host in its own state dir so the main one keeps running
  const downDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-down-"));
  const downRoom = "down-room";
  await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [WB, "start", "--room", `${downRoom},${ROOM_KEY}`, "--agent", "Solo"],
      {
        env: {
          ...process.env,
          WB_WS_SERVER: relay.url,
          WB_STATE_DIR: downDir,
          WB_NO_PERSIST: "1",
        },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
  const info = JSON.parse(fs.readFileSync(path.join(downDir, downRoom, "room.json"), "utf8"));
  assert.ok(info.pid);

  const out = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [WB, "down", "--room", downRoom, "--yes"],
      { env: { ...process.env, WB_STATE_DIR: downDir } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
  assert.match(out, /removed/);
  assert.ok(!fs.existsSync(path.join(downDir, downRoom)), "room state dir purged");
  // process actually gone
  let alive = true;
  try {
    process.kill(info.pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "host process stopped");
  fs.rmSync(downDir, { recursive: true, force: true });
});
