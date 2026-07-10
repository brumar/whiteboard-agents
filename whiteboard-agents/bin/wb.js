#!/usr/bin/env node
// wb — control CLI for whiteboard agents.
// A thin client over each agent daemon's localhost HTTP API.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoomLink } from "../lib/crypto.js";
import { runDaemon } from "../lib/daemon.js";

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

function die(msg) {
  console.error(`wb: ${msg}`);
  process.exit(1);
}

function agentInfos() {
  const infos = [];
  if (!fs.existsSync(STATE_DIR)) return infos;
  for (const room of fs.readdirSync(STATE_DIR)) {
    const dir = path.join(STATE_DIR, room);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".json") && !f.endsWith(".seen.json")) {
        try {
          infos.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
        } catch {}
      }
    }
  }
  return infos;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveAgent() {
  const infos = agentInfos().filter((i) => isAlive(i.pid));
  const room = args.room ? parseRoomLink(args.room).roomId : null;
  const candidates = infos.filter(
    (i) => (!room || i.roomId === room) && (!args.agent || i.agent === args.agent),
  );
  if (!candidates.length) die("no running agent matches (use `wb start` first, or check --agent/--room)");
  if (candidates.length > 1 && !args.agent)
    die(`multiple agents running (${candidates.map((c) => c.agent).join(", ")}) — pass --agent`);
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

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const HELP = `wb — whiteboard agent control

setup:
  wb start --room <link> --agent <name> [--color <hex>] [--bg <hex>] [--slot <n>]
  wb up --room <link> [--personas <file>]     start all personas from agents/personas.json
  wb list                                     running agents
  wb stop [--agent <name>] [--all]
  wb health [--agent <name>]

observing (all target one agent; --agent needed when several run):
  wb scene [--full] [--deleted]               board contents (summaries by default)
  wb diff                                     unseen changes by others
  wb wait [--timeout <s>]                     block until changes at next 10s tick

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
    case "daemon": {
      // internal: the long-running process behind `wb start`
      const { roomId, roomKey } = parseRoomLink(args.room);
      await runDaemon({
        roomId,
        roomKey,
        agent: args.agent,
        color: args.color,
        background: args.bg,
        slot: Number(args.slot || 0),
        stateDir: STATE_DIR,
      });
      break; // keeps running (server + intervals hold the loop)
    }

    case "start": {
      if (!args.room || !args.agent) die("start requires --room and --agent");
      const { roomId } = parseRoomLink(args.room);
      fs.mkdirSync(path.join(STATE_DIR, roomId), { recursive: true });
      const logPath = path.join(STATE_DIR, roomId, `${args.agent}.log`);
      const infoPath = path.join(STATE_DIR, roomId, `${args.agent}.json`);
      const existing = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, "utf8")) : null;
      if (existing && isAlive(existing.pid)) {
        print({ ok: true, alreadyRunning: true, ...existing });
        break;
      }
      if (fs.existsSync(infoPath)) fs.unlinkSync(infoPath);
      const out = fs.openSync(logPath, "a");
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          "daemon",
          "--room",
          args.room,
          "--agent",
          args.agent,
          ...(args.color ? ["--color", args.color] : []),
          ...(args.bg ? ["--bg", args.bg] : []),
          ...(args.slot ? ["--slot", String(args.slot)] : []),
        ],
        { detached: true, stdio: ["ignore", out, out] },
      );
      child.unref();
      // wait for the daemon to write its info file and come up healthy
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (fs.existsSync(infoPath)) {
          const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
          try {
            const h = await call(info, "GET", "/health");
            print({ ok: true, ...info, health: h });
            process.exit(0);
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      die(`daemon did not come up; check ${logPath}`);
      break;
    }

    case "up": {
      if (!args.room) die("up requires --room");
      const file = args.personas || path.join(PKG_ROOT, "agents", "personas.json");
      const personas = JSON.parse(fs.readFileSync(file, "utf8")).personas;
      for (let i = 0; i < personas.length; i++) {
        const p = personas[i];
        const r = spawnSyncSelf([
          "start",
          "--room",
          args.room,
          "--agent",
          p.name,
          "--color",
          p.color,
          "--bg",
          p.background,
          "--slot",
          String(i),
        ]);
        console.log(r.trim());
      }
      break;
    }

    case "list": {
      const infos = agentInfos().map((i) => ({ ...i, alive: isAlive(i.pid) }));
      print(infos);
      break;
    }

    case "stop": {
      const infos = agentInfos().filter((i) => isAlive(i.pid));
      const targets = args.all ? infos : infos.filter((i) => !args.agent || i.agent === args.agent);
      if (!targets.length) die("nothing to stop");
      for (const t of targets) {
        try {
          await call(t, "POST", "/quit");
        } catch {
          try {
            process.kill(t.pid);
          } catch {}
        }
        console.log(`stopped ${t.agent} (room ${t.roomId})`);
      }
      break;
    }

    case "health": {
      print(await call(resolveAgent(), "GET", "/health"));
      break;
    }
    case "scene": {
      const q = new URLSearchParams();
      if (args.full) q.set("full", "1");
      if (args.deleted) q.set("deleted", "1");
      print(await call(resolveAgent(), "GET", `/scene?${q}`));
      break;
    }
    case "diff": {
      print(await call(resolveAgent(), "GET", "/diff"));
      break;
    }
    case "wait": {
      const t = Number(args.timeout || 60);
      print(await call(resolveAgent(), "GET", `/wait?timeout=${t}`));
      break;
    }

    case "op": {
      const json = args.json || (await readStdin());
      if (!json) die("op requires --json or JSON on stdin");
      const body = JSON.parse(json);
      print(await call(resolveAgent(), "POST", "/op", body.ops ? body : { ops: [body] }));
      break;
    }
    case "note":
    case "text": {
      if (!args.text) die(`${cmd} requires --text`);
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
      print(await call(resolveAgent(), "POST", "/op", { ops: [op] }));
      break;
    }
    case "arrow": {
      const op = {
        op: "arrow",
        ...(args.from ? { from: args.from, to: args.to } : {}),
        ...(args.label ? { label: args.label } : {}),
        ...(args.style ? { style: args.style } : {}),
        ...(args.color ? { color: args.color } : {}),
      };
      print(await call(resolveAgent(), "POST", "/op", { ops: [op] }));
      break;
    }
    case "react": {
      print(
        await call(resolveAgent(), "POST", "/op", {
          ops: [{ op: "react", target: args.target, emoji: args.emoji }],
        }),
      );
      break;
    }
    case "sketch": {
      print(
        await call(resolveAgent(), "POST", "/op", {
          ops: [{ op: "sketch", kind: args.kind || "underline", target: args.target, x: numOr(args.x), y: numOr(args.y), w: numOr(args.w), h: numOr(args.h) }],
        }),
      );
      break;
    }
    case "status": {
      print(await call(resolveAgent(), "POST", "/op", { ops: [{ op: "status", text: args.text }] }));
      break;
    }
    case "cursor": {
      print(
        await call(resolveAgent(), "POST", "/cursor", {
          x: numOr(args.x),
          y: numOr(args.y),
          ms: numOr(args.ms) || 800,
          ...(args.target ? { target: args.target } : {}),
        }),
      );
      break;
    }
    case "gesture": {
      print(
        await call(resolveAgent(), "POST", "/gesture", {
          kind: args.kind || "point",
          ...(args.target ? { target: args.target } : { x: numOr(args.x), y: numOr(args.y) }),
        }),
      );
      break;
    }
    case "ack": {
      print(
        await call(resolveAgent(), "POST", "/ack", {
          ids: String(args.ids || "").split(",").filter(Boolean),
          glance: !!args.glance,
        }),
      );
      break;
    }
    case "save": {
      print(await call(resolveAgent(), "POST", "/save"));
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

function spawnSyncSelf(argv) {
  return execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
    encoding: "utf8",
  });
}
