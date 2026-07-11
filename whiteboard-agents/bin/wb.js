#!/usr/bin/env node
// wb — control CLI for whiteboard agents.
// A thin client over the room host's localhost HTTP API. One host process per
// room carries every agent identity; commands address agents by name.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoomLink } from "../lib/crypto.js";
import { runDaemon } from "../lib/daemon.js";
import { runRoomHost } from "../lib/roomhost.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const STATE_DIR = process.env.WB_STATE_DIR || path.join(PKG_ROOT, ".wb");

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);

function parseArgs(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith("--")) {
      const key = list[i].slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(list[i]);
  }
  return out;
}

let SECRET_KEY = null; // set once a room key is resolved; kept out of all output

function die(msg) {
  console.error(`wb: ${SECRET_KEY ? String(msg).replaceAll(SECRET_KEY, "…") : msg}`);
  process.exit(1);
}

// Room id without requiring the key ("<id>", "<id>,<key>" or a full link).
function roomIdOf(room) {
  try {
    return parseRoomLink(room).roomId;
  } catch {
    return String(room).trim();
  }
}

// Resolve {roomId, roomKey} from, in priority order: the --room link itself,
// WB_ROOM_KEY, --key-file, then the room's persisted key file (written 0600 by
// the host) — so the key stops appearing in argv after the first command.
function resolveRoom() {
  if (!args.room) die("this command requires --room");
  let roomId, roomKey;
  try {
    ({ roomId, roomKey } = parseRoomLink(args.room));
  } catch {
    roomId = String(args.room).trim();
  }
  if (!roomKey && process.env.WB_ROOM_KEY) roomKey = process.env.WB_ROOM_KEY.trim();
  if (!roomKey && args["key-file"]) {
    roomKey = fs.readFileSync(args["key-file"], "utf8").trim();
  }
  if (!roomKey) {
    const keyPath = path.join(STATE_DIR, roomId, "room.key");
    if (fs.existsSync(keyPath)) roomKey = fs.readFileSync(keyPath, "utf8").trim();
  }
  if (!roomKey)
    die(`no key for room ${roomId} — pass a full room link once, WB_ROOM_KEY, or --key-file`);
  SECRET_KEY = roomKey;
  return { roomId, roomKey };
}

// Persist the key (0600) so later commands and the host child never see it in argv.
function persistRoomKey(roomId, roomKey) {
  const dirPath = path.join(STATE_DIR, roomId);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, "room.key"), roomKey, { mode: 0o600 });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// room.json files written by room hosts (one per room)
function roomInfos() {
  const infos = [];
  if (!fs.existsSync(STATE_DIR)) return infos;
  for (const room of fs.readdirSync(STATE_DIR)) {
    const p = path.join(STATE_DIR, room, "room.json");
    if (!fs.existsSync(p)) continue;
    try {
      infos.push(JSON.parse(fs.readFileSync(p, "utf8")));
    } catch {}
  }
  return infos;
}

// legacy per-agent daemons (pre-roomhost info files carry no `version`)
function legacyAgentInfos() {
  const infos = [];
  if (!fs.existsSync(STATE_DIR)) return infos;
  for (const room of fs.readdirSync(STATE_DIR)) {
    const dir = path.join(STATE_DIR, room);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json") || f.endsWith(".seen.json") || f === "room.json") continue;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (!info.version) infos.push(info);
      } catch {}
    }
  }
  return infos;
}

// Resolve a target host + agent name for observation/action commands.
function resolveTarget({ agentRequired = true } = {}) {
  const roomFilter = args.room ? roomIdOf(args.room) : null;
  const rooms = roomInfos().filter((r) => isAlive(r.pid) && (!roomFilter || r.roomId === roomFilter));
  const candidates = [];
  for (const r of rooms) {
    for (const a of r.agents || []) {
      if (!args.agent || a.name === args.agent) candidates.push({ info: r, agent: a.name });
    }
  }
  if (!candidates.length) {
    // legacy daemons
    for (const i of legacyAgentInfos().filter(
      (i) => isAlive(i.pid) && (!roomFilter || i.roomId === roomFilter),
    )) {
      if (!args.agent || i.agent === args.agent) candidates.push({ info: i, agent: i.agent });
    }
  }
  if (!candidates.length)
    die("no running agent matches (use `wb start` first, or check --agent/--room)");
  if (candidates.length > 1 && !args.agent && agentRequired)
    die(
      `multiple agents running (${candidates.map((c) => c.agent).join(", ")}) — pass --agent`,
    );
  return candidates[0];
}

async function call(info, method, pathname, body) {
  const res = await fetch(`http://127.0.0.1:${info.port}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function withAgent(pathname, agent, extra = "") {
  const q = new URLSearchParams(extra);
  if (agent) q.set("agent", agent);
  const qs = q.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function aliveRoom(roomId) {
  const p = path.join(STATE_DIR, roomId, "room.json");
  if (!fs.existsSync(p)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(p, "utf8"));
    return isAlive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

async function spawnHost(room, agentSpecs) {
  const { roomId, roomKey } = room;
  const dir = path.join(STATE_DIR, roomId);
  fs.mkdirSync(dir, { recursive: true });
  const roomInfoPath = path.join(dir, "room.json");
  if (fs.existsSync(roomInfoPath)) fs.unlinkSync(roomInfoPath);
  const logPath = path.join(dir, "host.log");
  const out = fs.openSync(logPath, "a");
  // key travels via the 0600 key file, never via the child's argv
  persistRoomKey(roomId, roomKey);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "host",
      "--room",
      roomId,
      "--agents-json",
      JSON.stringify(agentSpecs),
      ...(args["on-change"] ? ["--on-change", args["on-change"]] : []),
    ],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const info = aliveRoom(roomId);
    if (info) {
      try {
        const h = await call(info, "GET", "/health");
        return { info, health: h };
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  die(`room host did not come up; check ${logPath}`);
}

const HELP = `wb — whiteboard agent control

setup (one host process per room carries all agent identities):
  wb start --room <link> --agent <name> [--color <hex>] [--bg <hex>] [--slot <n>]
                                              spawn the room host, or join it if already up
  wb up --room <link> [--personas <file>] [--on-change '<cmd>']
                                              start/complete the whole cast (agents/personas.json);
                                              --on-change runs <cmd> when the board changes and no
                                              brain is long-polling (env: WB_ROOM WB_AGENTS WB_REASON)
  wb list                                     running rooms and their agents
  wb stop [--agent <name>] [--all]            detach one agent, or stop the host
  wb down --room <id> [--yes]                 stop the host AND purge .wb/<roomId>/ state
  wb health

room addressing & secrets: after the first command with a full link, the key is
stored at .wb/<roomId>/room.key (0600) — every command then accepts a bare
--room <id>. Key sources (in order): link, WB_ROOM_KEY, --key-file, room.key.

observing (all target one agent; --agent needed when several run):
  wb scene [--full] [--deleted] [--fields id,text,author]   board contents (summaries by default)
  wb diff [--since <sceneVersion>]            unseen changes by others
  wb wait [--timeout <s>]                     block until the board changes (~2s debounce)
  wb render [--out board.png] [--crop content|frame:<id>]   PNG through the host's warm renderer
  wb file --id <fileId> [--out <path>]        fetch+decrypt a board image (summaries flag them
                                              with hasImage/fileId — go look before replying)
  wb view                                     print the live read-only viewer URL (/view, SSE-fed)
  wb journal [--tail <n>]                     the room's replayable session journal (jsonl)

acting:
  wb op --json '<op-or-{"ops":[...]}>'        high-level ops (see below); or pipe JSON on stdin
  wb note --text "..." [--near <id>] [--x --y] [--bg <hex>] [--width <n>] [--ack-of <id>]
  wb text --text "..." [--near <id>] [--x --y] [--size <n>]
  wb arrow --from <id> --to <id> [--label "..."] [--style dashed]
  wb react --target <id> [--emoji "💡"]
  wb sketch --kind circle|underline|check --target <id>
  wb status --text "..."                      update this agent's status card
  wb cursor --x <n> --y <n> [--ms <n>] | --target <id>
  wb gesture --kind point|circle|wave --target <id>
  wb ack --ids <id,id,...> [--glance]         mark changes as seen
  wb save                                     force persistence to excalidraw's backend

ops for \`wb op\`: note, text, shape, arrow, react, sketch, frame, status, update, delete, raw
`;

try {
  switch (cmd) {
    case "host": {
      // internal: the long-running room-host process behind `wb start`/`wb up`
      const { roomId, roomKey } = resolveRoom();
      const agents = JSON.parse(args["agents-json"] || "[]");
      await runRoomHost({
        roomId,
        roomKey,
        agents,
        stateDir: STATE_DIR,
        onChange: args["on-change"] || null,
      });
      break; // keeps running (server + intervals hold the loop)
    }

    case "daemon": {
      // legacy internal: single-agent host (kept so old invocations work)
      const { roomId, roomKey } = resolveRoom();
      await runDaemon({
        roomId,
        roomKey,
        agent: args.agent,
        color: args.color,
        background: args.bg,
        slot: Number(args.slot || 0),
        stateDir: STATE_DIR,
      });
      break;
    }

    case "start": {
      if (!args.room || !args.agent) die("start requires --room and --agent");
      const room = resolveRoom();
      const existing = aliveRoom(room.roomId);
      if (existing) {
        if ((existing.agents || []).some((a) => a.name === args.agent)) {
          print({ ok: true, alreadyRunning: true, ...existing });
          break;
        }
        const r = await call(existing, "POST", "/agents", {
          name: args.agent,
          color: args.color,
          bg: args.bg,
          slot: args.slot !== undefined ? Number(args.slot) : undefined,
        });
        print({ ok: true, joined: true, port: existing.port, ...r });
        break;
      }
      const { info, health } = await spawnHost(room, [
        {
          name: args.agent,
          color: args.color,
          background: args.bg,
          slot: Number(args.slot || 0),
        },
      ]);
      print({ ok: true, ...info, health });
      break;
    }

    case "up": {
      if (!args.room) die("up requires --room");
      const room = resolveRoom();
      const file = args.personas || path.join(PKG_ROOT, "agents", "personas.json");
      const personas = JSON.parse(fs.readFileSync(file, "utf8")).personas;
      const specs = personas.map((p, i) => ({
        name: p.name,
        color: p.color,
        background: p.background,
        slot: i,
      }));
      const existing = aliveRoom(room.roomId);
      if (existing) {
        const present = new Set((existing.agents || []).map((a) => a.name));
        for (const s of specs) {
          if (present.has(s.name)) continue;
          const r = await call(existing, "POST", "/agents", {
            name: s.name,
            color: s.color,
            bg: s.background,
            slot: s.slot,
          });
          console.log(`joined ${r.agent} (slot ${r.slot})`);
        }
        print({ ok: true, ...aliveRoom(room.roomId) });
        break;
      }
      const { info, health } = await spawnHost(room, specs);
      print({ ok: true, ...info, health });
      break;
    }

    case "list": {
      const rooms = roomInfos().map((r) => ({ ...r, alive: isAlive(r.pid) }));
      const legacy = legacyAgentInfos().map((i) => ({ ...i, alive: isAlive(i.pid), legacy: true }));
      print([...rooms, ...legacy]);
      break;
    }

    case "stop": {
      const roomFilter = args.room ? roomIdOf(args.room) : null;
      const rooms = roomInfos().filter(
        (r) => isAlive(r.pid) && (!roomFilter || r.roomId === roomFilter),
      );
      const legacy = legacyAgentInfos().filter(
        (i) => isAlive(i.pid) && (!roomFilter || i.roomId === roomFilter),
      );
      if (args.agent && !args.all) {
        // detach one identity without killing the host
        const room = rooms.find((r) => (r.agents || []).some((a) => a.name === args.agent));
        if (room) {
          if ((room.agents || []).length === 1) {
            await call(room, "POST", "/quit");
            console.log(`stopped host for room ${room.roomId} (last agent ${args.agent})`);
          } else {
            await call(room, "DELETE", `/agents/${encodeURIComponent(args.agent)}`);
            console.log(`detached ${args.agent} (room ${room.roomId})`);
          }
          break;
        }
        const d = legacy.find((i) => i.agent === args.agent);
        if (!d) die("nothing to stop");
        try {
          await call(d, "POST", "/quit");
        } catch {
          try {
            process.kill(d.pid);
          } catch {}
        }
        console.log(`stopped ${d.agent} (room ${d.roomId})`);
        break;
      }
      if (!rooms.length && !legacy.length) die("nothing to stop");
      for (const r of rooms) {
        try {
          await call(r, "POST", "/quit");
        } catch {
          try {
            process.kill(r.pid);
          } catch {}
        }
        console.log(`stopped host for room ${r.roomId} (${(r.agents || []).length} agents)`);
      }
      for (const d of legacy) {
        try {
          await call(d, "POST", "/quit");
        } catch {
          try {
            process.kill(d.pid);
          } catch {}
        }
        console.log(`stopped ${d.agent} (room ${d.roomId})`);
      }
      break;
    }

    case "health": {
      const { info } = resolveTarget({ agentRequired: false });
      print(await call(info, "GET", "/health"));
      break;
    }
    case "scene": {
      const { info, agent } = resolveTarget({ agentRequired: false });
      const q = new URLSearchParams();
      if (args.full) q.set("full", "1");
      if (args.deleted) q.set("deleted", "1");
      if (args.fields) q.set("fields", args.fields);
      print(await call(info, "GET", withAgent("/scene", args.agent ? agent : null, q)));
      break;
    }
    case "diff": {
      const { info, agent } = resolveTarget();
      const q = new URLSearchParams();
      if (args.since !== undefined) q.set("since", String(args.since));
      print(await call(info, "GET", withAgent("/diff", agent, q)));
      break;
    }
    case "wait": {
      const { info, agent } = resolveTarget();
      const t = Number(args.timeout || 60);
      print(await call(info, "GET", withAgent("/wait", agent, `timeout=${t}`)));
      break;
    }
    case "render": {
      const { info } = resolveTarget({ agentRequired: false });
      const outPath = args.out || "board.png";
      const q = new URLSearchParams();
      if (args.crop) q.set("crop", args.crop);
      const res = await fetch(`http://127.0.0.1:${info.port}/render?${q}`);
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = (await res.json()).error || msg;
        } catch {}
        die(`render failed: ${msg}`);
      }
      fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
      console.error(`rendered ${res.headers.get("x-rendered-elements")} elements`);
      console.log(outPath);
      break;
    }

    case "file": {
      if (!args.id) die("file requires --id <fileId>");
      const { info } = resolveTarget({ agentRequired: false });
      const res = await fetch(
        `http://127.0.0.1:${info.port}/file?id=${encodeURIComponent(args.id)}`,
      );
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = (await res.json()).error || msg;
        } catch {}
        die(`file failed: ${msg}`);
      }
      const mime = res.headers.get("content-type") || "";
      const ext =
        {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/svg+xml": "svg",
          "image/gif": "gif",
          "image/webp": "webp",
        }[mime] || "bin";
      const outPath = args.out || `${args.id}.${ext}`;
      fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
      console.error(`${mime || "unknown type"}, ${fs.statSync(outPath).size} bytes`);
      console.log(outPath);
      break;
    }

    case "op": {
      const { info, agent } = resolveTarget();
      const json = args.json || (await readStdin());
      if (!json) die("op requires --json or JSON on stdin");
      const body = JSON.parse(json);
      print(
        await call(info, "POST", withAgent("/op", agent), body.ops ? body : { ops: [body] }),
      );
      break;
    }
    case "note":
    case "text": {
      if (!args.text) die(`${cmd} requires --text`);
      const { info, agent } = resolveTarget();
      const op = {
        op: cmd,
        text: args.text,
        ...(args.near ? { near: args.near } : {}),
        ...(args.x != null ? { x: Number(args.x), y: Number(args.y) } : {}),
        ...(args.bg ? { bg: args.bg } : {}),
        ...(args.color ? { color: args.color } : {}),
        ...(args.width ? { width: Number(args.width) } : {}),
        ...(args.size ? { size: Number(args.size) } : {}),
        ...(args["ack-of"] ? { ackOf: args["ack-of"], kind: "ack" } : {}),
      };
      print(await call(info, "POST", withAgent("/op", agent), { ops: [op] }));
      break;
    }
    case "arrow": {
      const { info, agent } = resolveTarget();
      const op = {
        op: "arrow",
        ...(args.from ? { from: args.from, to: args.to } : {}),
        ...(args.label ? { label: args.label } : {}),
        ...(args.style ? { style: args.style } : {}),
        ...(args.color ? { color: args.color } : {}),
      };
      print(await call(info, "POST", withAgent("/op", agent), { ops: [op] }));
      break;
    }
    case "react": {
      const { info, agent } = resolveTarget();
      print(
        await call(info, "POST", withAgent("/op", agent), {
          ops: [{ op: "react", target: args.target, emoji: args.emoji }],
        }),
      );
      break;
    }
    case "sketch": {
      const { info, agent } = resolveTarget();
      print(
        await call(info, "POST", withAgent("/op", agent), {
          ops: [
            {
              op: "sketch",
              kind: args.kind || "underline",
              target: args.target,
              x: numOr(args.x),
              y: numOr(args.y),
              w: numOr(args.w),
              h: numOr(args.h),
            },
          ],
        }),
      );
      break;
    }
    case "status": {
      const { info, agent } = resolveTarget();
      print(
        await call(info, "POST", withAgent("/op", agent), {
          ops: [{ op: "status", text: args.text }],
        }),
      );
      break;
    }
    case "cursor": {
      const { info, agent } = resolveTarget();
      print(
        await call(info, "POST", withAgent("/cursor", agent), {
          x: numOr(args.x),
          y: numOr(args.y),
          ms: numOr(args.ms) || 800,
          ...(args.target ? { target: args.target } : {}),
        }),
      );
      break;
    }
    case "gesture": {
      const { info, agent } = resolveTarget();
      print(
        await call(info, "POST", withAgent("/gesture", agent), {
          kind: args.kind || "point",
          ...(args.target ? { target: args.target } : { x: numOr(args.x), y: numOr(args.y) }),
        }),
      );
      break;
    }
    case "ack": {
      const { info, agent } = resolveTarget();
      print(
        await call(info, "POST", withAgent("/ack", agent), {
          ids: String(args.ids || "").split(",").filter(Boolean),
          glance: !!args.glance,
        }),
      );
      break;
    }
    case "save": {
      const { info } = resolveTarget({ agentRequired: false });
      print(await call(info, "POST", "/save"));
      break;
    }

    case "journal": {
      // prefer the live host; fall back to reading the file (host down)
      const tail = Number(args.tail || 100);
      try {
        const { info } = resolveTarget({ agentRequired: false });
        const { entries } = await call(info, "GET", `/journal?tail=${tail}`);
        for (const e of entries) console.log(JSON.stringify(e));
        break;
      } catch {}
      if (!args.room) die("no running host — pass --room <id> to read the journal file");
      const p = path.join(STATE_DIR, roomIdOf(args.room), "journal.jsonl");
      if (!fs.existsSync(p)) die(`no journal at ${p}`);
      const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).slice(-tail);
      for (const l of lines) console.log(l);
      break;
    }

    case "view": {
      const { info } = resolveTarget({ agentRequired: false });
      console.log(`http://127.0.0.1:${info.port}/view`);
      break;
    }

    case "down": {
      if (!args.room) die("down requires --room <id-or-link>");
      const roomId = roomIdOf(args.room);
      const dirPath = path.join(STATE_DIR, roomId);
      if (!fs.existsSync(dirPath)) die(`no state for room ${roomId}`);
      if (!args.yes) {
        process.stdout.write(`wb: delete all state for room ${roomId} (${dirPath})? [y/N] `);
        const answer = (await readStdin()).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") die("aborted");
      }
      const info = aliveRoom(roomId);
      if (info) {
        try {
          await call(info, "POST", "/quit");
        } catch {
          try {
            process.kill(info.pid);
          } catch {}
        }
        // wait briefly for the process to exit so files aren't rewritten
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && isAlive(info.pid)) {
          await new Promise((r) => setTimeout(r, 100));
        }
        console.log(`stopped host for room ${roomId}`);
      }
      fs.rmSync(dirPath, { recursive: true, force: true });
      console.log(`removed ${dirPath}`);
      break;
    }

    default:
      console.log(HELP);
      process.exit(cmd && cmd !== "help" ? 1 : 0);
  }
} catch (err) {
  die(err.message);
}

function numOr(v) {
  return v === undefined ? undefined : Number(v);
}
