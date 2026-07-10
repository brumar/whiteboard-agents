// Agent daemon: one long-lived process per agent on a board.
// Holds the socket connection (identity + cursor presence), reconciles the
// scene, computes diffs on a 10s tick, persists to Firestore, and exposes a
// localhost HTTP API that the agent's "brain" (a Claude instance) drives.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ExcalidrawClient } from "./client.js";
import { loadScene, mergeSaveScene } from "./persistence.js";
import {
  makeText,
  makeShape,
  makeNote,
  makeArrow,
  makeFreedraw,
  makeFrame,
  indexAfter,
  maxIndex,
  bbox,
  findFreeSpace,
  edgeToEdge,
  measureText,
} from "./elements.js";

const POLL_MS = 10_000; // board polling cadence
const CURSOR_FPS_MS = 66; // ~15fps cursor animation frames
const CORNER = { x: -560, y: -460 }; // Agents' Corner (status cards)

export async function runDaemon(opts) {
  const {
    roomId,
    roomKey,
    agent,
    color = "#1971c2",
    background = "#a5d8ff",
    slot = 0,
    stateDir,
  } = opts;

  const dir = path.join(stateDir, roomId);
  fs.mkdirSync(dir, { recursive: true });
  const seenPath = path.join(dir, `${agent}.seen.json`);
  const infoPath = path.join(dir, `${agent}.json`);

  // seen: elementId -> last acked version
  const seen = new Map(
    fs.existsSync(seenPath) ? Object.entries(JSON.parse(fs.readFileSync(seenPath, "utf8"))) : [],
  );
  const saveSeen = () =>
    fs.writeFileSync(seenPath, JSON.stringify(Object.fromEntries(seen.entries())));

  const client = new ExcalidrawClient({ roomId, roomKey, username: `🤖 ${agent}` });

  const state = {
    cursor: { x: CORNER.x + 60 + slot * 40, y: CORNER.y + 60 },
    animTarget: null,
    animQueue: [],
    pointers: [], // recent human/agent pointer sightings
    dirty: false,
    lastForeign: null, // last foreign element added (for auto-glance)
    startedAt: Date.now(),
    log: [],
  };

  const logEvent = (msg) => {
    state.log.push({ ts: Date.now(), msg });
    if (state.log.length > 200) state.log.shift();
    console.log(new Date().toISOString(), msg);
  };

  // ---- authorship helpers -------------------------------------------------
  const authorOf = (el) => el?.customData?.wb?.agent || "human";
  const isMine = (el) => authorOf(el) === agent;

  const summarize = (el) => ({
    id: el.id,
    type: el.type,
    author: authorOf(el),
    x: Math.round(el.x),
    y: Math.round(el.y),
    w: Math.round(el.width || 0),
    h: Math.round(el.height || 0),
    version: el.version,
    deleted: !!el.isDeleted,
    ...(el.text != null ? { text: el.originalText ?? el.text } : {}),
    ...(el.name != null ? { name: el.name } : {}),
    ...(el.containerId ? { containerId: el.containerId } : {}),
    ...(el.customData?.wb?.kind ? { kind: el.customData.wb.kind } : {}),
    ...(el.customData?.wb?.ackOf ? { ackOf: el.customData.wb.ackOf } : {}),
  });

  const liveElements = () => client.getElements({ includeDeleted: false });

  const computeDiff = () => {
    const changes = [];
    for (const el of client.getElements()) {
      if (isMine(el)) continue;
      const seenV = Number(seen.get(el.id) ?? -1);
      if ((el.version ?? 0) > seenV) changes.push(summarize(el));
    }
    return changes;
  };

  // ---- connect + initial scene -------------------------------------------
  try {
    const persisted = await loadScene(roomId, roomKey);
    if (persisted?.elements?.length) {
      client.reconcile(persisted.elements);
      logEvent(`loaded ${persisted.elements.length} persisted elements`);
    }
  } catch (err) {
    logEvent(`persistence load failed: ${err.message}`);
  }

  await client.connect();
  logEvent(`connected as ${client.socket?.id} (${client.collaborators.size} in room)`);

  client.on("scene-changed", (els) => {
    state.dirty = true;
    const foreign = els.filter((e) => !isMine(e));
    if (foreign.length) {
      state.lastForeign = { els: foreign.map(summarize), ts: Date.now() };
      // presence: glance toward the newest foreign element
      const el = foreign[foreign.length - 1];
      if (el && Number.isFinite(el.x)) {
        enqueueMove(el.x + (el.width || 0) / 2 + 30, el.y - 20, 900);
      }
    }
  });
  client.on("pointer", (p) => {
    state.pointers.push({ username: p.username, ...p.pointer, ts: Date.now() });
    if (state.pointers.length > 100) state.pointers.shift();
  });
  client.on("disconnect", (reason) => logEvent(`disconnected: ${reason} (auto-reconnects)`));

  // ---- cursor animation ----------------------------------------------------
  function enqueueMove(x, y, ms = 800) {
    state.animQueue.push({ x, y, ms });
  }

  let animFrame = null;
  function startAnimLoop() {
    if (animFrame) return;
    let current = null;
    animFrame = setInterval(async () => {
      if (!current) {
        current = state.animQueue.shift();
        if (current) {
          current.from = { ...state.cursor };
          current.t0 = Date.now();
        }
      }
      if (current) {
        const t = Math.min(1, (Date.now() - current.t0) / current.ms);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
        const wobble = Math.sin(t * Math.PI * 3) * 4 * (1 - t);
        state.cursor.x = current.from.x + (current.x - current.from.x) * e + wobble;
        state.cursor.y = current.from.y + (current.y - current.from.y) * e - wobble;
        await client.sendCursor(state.cursor.x, state.cursor.y);
        if (t >= 1) current = null;
      }
    }, CURSOR_FPS_MS);
  }
  startAnimLoop();

  // idle drift: tiny wanderings so the cursor feels alive
  setInterval(() => {
    if (state.animQueue.length === 0) {
      enqueueMove(
        state.cursor.x + (Math.random() - 0.5) * 30,
        state.cursor.y + (Math.random() - 0.5) * 30,
        1200,
      );
    }
  }, 3500 + Math.random() * 2500);

  // stay "active" in the collaborators list
  setInterval(() => client.sendIdleStatus("active"), 20_000);

  // ---- persistence ---------------------------------------------------------
  let saveTimer = null;
  const scheduleSave = (delay = 1500) => {
    state.dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await mergeSaveScene(roomId, roomKey, client.getElements());
        state.dirty = false;
        logEvent("scene persisted");
      } catch (err) {
        logEvent(`persist failed: ${err.message}`);
      }
    }, delay);
  };
  setInterval(() => {
    if (state.dirty && !saveTimer) scheduleSave(0);
  }, 60_000);

  // ---- element insertion ---------------------------------------------------
  async function insertElements(els) {
    let idx = maxIndex(client.getElements());
    for (const el of els) {
      if (!el.index) {
        idx = indexAfter(idx);
        el.index = idx;
      }
      el.customData = { ...(el.customData || {}), wb: { agent, ...(el.customData?.wb || {}) } };
      seen.set(el.id, el.version); // own work is pre-acked
    }
    await client.syncElements(els);
    saveSeen();
    scheduleSave();
    return els.map((e) => e.id);
  }

  function getEl(id) {
    return client.scene.get(id);
  }

  function placeNear(targetId, w, h) {
    const anchor = targetId ? bbox(getEl(targetId)) : null;
    const start = anchor
      ? { x: anchor.x + anchor.w + 40, y: anchor.y }
      : contentEdge(w, h);
    return findFreeSpace(liveElements(), { x: start.x, y: start.y, w, h });
  }

  function contentEdge(w, h) {
    const els = liveElements().filter((e) => e.type !== "frame");
    if (!els.length) return { x: 100, y: 100 };
    const recent = state.lastForeign?.els?.[0];
    const maxX = Math.max(...els.map((e) => e.x + (e.width || 0)));
    const y = recent ? recent.y : Math.min(...els.map((e) => e.y));
    return { x: maxX + 80, y };
  }

  // ---- high-level ops -------------------------------------------------------
  async function applyOp(op) {
    switch (op.op) {
      case "note": {
        const width = op.width || 220;
        const pos =
          op.x != null ? { x: op.x, y: op.y } : placeNear(op.near, width, 100);
        const els = makeNote({
          text: op.text,
          x: pos.x,
          y: pos.y,
          width,
          strokeColor: op.color || color,
          backgroundColor: op.bg || background,
          shape: op.shape || "rectangle",
          fontSize: op.size || 16,
          customData: { wb: { kind: op.kind || "note", ...(op.ackOf ? { ackOf: op.ackOf } : {}) } },
        });
        await visit(pos.x + width / 2, pos.y - 30);
        return insertElements(els);
      }
      case "text": {
        const size = op.size || 20;
        const m = measureText(op.text, size);
        const pos = op.x != null ? { x: op.x, y: op.y } : placeNear(op.near, m.width, m.height);
        const el = makeText({
          text: op.text,
          x: pos.x,
          y: pos.y,
          fontSize: size,
          strokeColor: op.color || color,
          customData: { wb: { kind: op.kind || "text" } },
        });
        await visit(pos.x, pos.y - 30);
        return insertElements([el]);
      }
      case "shape": {
        const pos = op.x != null ? { x: op.x, y: op.y } : placeNear(op.near, op.w || 160, op.h || 90);
        const el = makeShape({
          shape: op.shape || "rectangle",
          x: pos.x,
          y: pos.y,
          width: op.w || 160,
          height: op.h || 90,
          strokeColor: op.color || color,
          backgroundColor: op.bg || "transparent",
          customData: { wb: { kind: "shape" } },
        });
        const created = [el];
        if (op.label) {
          const m = measureText(op.label, 16);
          created.push(
            makeText({
              text: op.label,
              x: pos.x + ((op.w || 160) - m.width) / 2,
              y: pos.y + ((op.h || 90) - m.height) / 2,
              fontSize: 16,
              strokeColor: op.color || color,
              customData: { wb: { kind: "label" } },
            }),
          );
        }
        return insertElements(created);
      }
      case "arrow": {
        let x, y, points;
        if (op.from && op.to) {
          const a = bbox(getEl(op.from));
          const b = bbox(getEl(op.to));
          if (!a || !b) throw new Error("arrow: from/to element not found");
          ({ x, y, points } = edgeToEdge(a, b));
        } else {
          ({ x, y, points } = op);
        }
        const el = makeArrow({
          x,
          y,
          points,
          strokeColor: op.color || color,
          strokeStyle: op.style || "solid",
          customData: { wb: { kind: "arrow" } },
        });
        const created = [el];
        if (op.label) {
          const mid = points[Math.floor(points.length / 2)];
          const m = measureText(op.label, 14);
          created.push(
            makeText({
              text: op.label,
              x: x + mid[0] / 2 - m.width / 2,
              y: y + mid[1] / 2 - m.height - 6,
              fontSize: 14,
              strokeColor: op.color || color,
              customData: { wb: { kind: "label" } },
            }),
          );
        }
        await visit(x, y - 20);
        return insertElements(created);
      }
      case "react": {
        const t = bbox(getEl(op.target));
        if (!t) throw new Error("react: target not found");
        const m = measureText(op.emoji || "👍", 24);
        const spot = findFreeSpace(liveElements(), {
          x: t.x + t.w + 8,
          y: t.y - m.height - 4,
          w: m.width,
          h: m.height,
          margin: 4,
          step: 20,
        });
        const el = makeText({
          text: op.emoji || "👍",
          x: spot.x,
          y: spot.y,
          fontSize: 24,
          strokeColor: color,
          customData: { wb: { kind: "reaction", ackOf: op.target } },
        });
        await visit(t.x + t.w / 2, t.y + t.h / 2, 600);
        return insertElements([el]);
      }
      case "sketch": {
        const t = op.target ? bbox(getEl(op.target)) : { x: op.x, y: op.y, w: op.w || 60, h: op.h || 30 };
        if (!t) throw new Error("sketch: target not found");
        let el;
        if (op.kind === "circle") {
          el = makeShape({
            shape: "ellipse",
            x: t.x - 16,
            y: t.y - 12,
            width: t.w + 32,
            height: t.h + 24,
            strokeColor: op.color || color,
            backgroundColor: "transparent",
            customData: { wb: { kind: "highlight", ackOf: op.target } },
          });
          el.roughness = 2;
        } else if (op.kind === "check") {
          el = makeFreedraw({
            x: t.x + t.w + 10,
            y: t.y + t.h / 2,
            points: [[0, 0], [8, 9], [11, 11], [26, -12], [30, -17]],
            strokeColor: op.color || color,
            strokeWidth: 2,
            customData: { wb: { kind: "check", ackOf: op.target } },
          });
        } else {
          // underline
          const pts = [];
          for (let i = 0; i <= 12; i++) {
            pts.push([(t.w / 12) * i, Math.sin(i * 1.1) * 2.5]);
          }
          el = makeFreedraw({
            x: t.x,
            y: t.y + t.h + 6,
            points: pts,
            strokeColor: op.color || color,
            strokeWidth: 2,
            customData: { wb: { kind: "underline", ackOf: op.target } },
          });
        }
        await visit(t.x + t.w / 2, t.y + t.h / 2, 600);
        return insertElements([el]);
      }
      case "frame": {
        const el = makeFrame({
          x: op.x,
          y: op.y,
          width: op.w,
          height: op.h,
          name: op.name,
          customData: { wb: { kind: "frame" } },
        });
        return insertElements([el]);
      }
      case "status": {
        // Agent status card in the Agents' Corner — one per agent, updated in place.
        const cardId = `wb-status-${agent}`;
        const existing = getEl(cardId);
        const text = `🤖 ${agent}\n${op.text}`;
        if (existing) {
          return patchElement(cardId, { text, originalText: text, ...measureText(text, 14) });
        }
        const el = makeText({
          text,
          x: CORNER.x + 20,
          y: CORNER.y + 30 + slot * 70,
          fontSize: 14,
          strokeColor: color,
          customData: { wb: { kind: "status" } },
        });
        el.id = cardId;
        const created = [el];
        if (!getEl("wb-agents-corner")) {
          const f = makeFrame({
            x: CORNER.x,
            y: CORNER.y,
            width: 340,
            height: 320,
            name: "🤖 Agents",
            customData: { wb: { kind: "frame" } },
          });
          f.id = "wb-agents-corner";
          created.unshift(f);
        }
        return insertElements(created);
      }
      case "update": {
        const el = getEl(op.id);
        if (!el) throw new Error("update: element not found");
        if (!isMine(el) && !op.force) throw new Error("update: refusing to edit non-own element");
        return patchElement(op.id, op.props || {});
      }
      case "delete": {
        const el = getEl(op.id);
        if (!el) throw new Error("delete: element not found");
        if (!isMine(el) && !op.force) throw new Error("delete: refusing to delete non-own element");
        return patchElement(op.id, { isDeleted: true });
      }
      case "raw": {
        return insertElements(op.elements);
      }
      default:
        throw new Error(`unknown op: ${op.op}`);
    }
  }

  async function patchElement(id, props) {
    const el = getEl(id);
    const next = {
      ...el,
      ...props,
      version: (el.version || 1) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    };
    client.scene.set(id, next);
    seen.set(id, next.version);
    await client.syncElements([next]);
    saveSeen();
    scheduleSave();
    return [id];
  }

  async function visit(x, y, ms = 900) {
    enqueueMove(x, y, ms);
    // wait for the move to play out so actions read sequentially
    await new Promise((r) => setTimeout(r, ms + 150));
  }

  // ---- 10s poll tick + long-poll waiters ------------------------------------
  const waiters = [];
  setInterval(() => {
    const diff = computeDiff();
    if (!diff.length) return;
    while (waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.respond({ changes: diff, ...contextInfo() });
    }
  }, POLL_MS);

  const contextInfo = () => ({
    collaborators: client.collaborators.size,
    recentPointers: state.pointers.filter((p) => Date.now() - p.ts < 30_000).slice(-10),
    agent,
    cursor: { x: Math.round(state.cursor.x), y: Math.round(state.cursor.y) },
  });

  // ---- HTTP API --------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const respond = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return respond(200, {
          ok: true,
          agent,
          roomId,
          connected: !!client.socket?.connected,
          collaborators: client.collaborators.size,
          elements: liveElements().length,
          uptimeMs: Date.now() - state.startedAt,
        });
      }
      if (req.method === "GET" && url.pathname === "/scene") {
        const full = url.searchParams.get("full") === "1";
        const els = client.getElements({ includeDeleted: url.searchParams.get("deleted") === "1" });
        return respond(200, {
          elements: full ? els : els.map(summarize),
          ...contextInfo(),
        });
      }
      if (req.method === "GET" && url.pathname === "/diff") {
        return respond(200, { changes: computeDiff(), ...contextInfo() });
      }
      if (req.method === "GET" && url.pathname === "/wait") {
        const timeout = Math.min(300, Number(url.searchParams.get("timeout") || 60)) * 1000;
        const diff = computeDiff();
        if (diff.length) return respond(200, { changes: diff, ...contextInfo() });
        const waiter = {
          respond: (obj) => respond(200, obj),
          timer: setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i >= 0) waiters.splice(i, 1);
            respond(200, { changes: [], timedOut: true, ...contextInfo() });
          }, timeout),
        };
        waiters.push(waiter);
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        if (url.pathname === "/op") {
          const ops = Array.isArray(body.ops) ? body.ops : [body];
          const ids = [];
          for (const op of ops) ids.push(...(await applyOp(op)));
          logEvent(`ops: ${ops.map((o) => o.op).join(",")} -> ${ids.join(",")}`);
          return respond(200, { ids });
        }
        if (url.pathname === "/cursor") {
          let { x, y, ms = 800, target } = body;
          if (target) {
            const t = bbox(getEl(target));
            if (!t) return respond(404, { error: "target not found" });
            x = t.x + t.w / 2;
            y = t.y + t.h / 2;
          }
          enqueueMove(x, y, ms);
          return respond(200, { ok: true });
        }
        if (url.pathname === "/gesture") {
          const t = body.target ? bbox(getEl(body.target)) : { x: body.x, y: body.y, w: 0, h: 0 };
          if (!t) return respond(404, { error: "target not found" });
          const cx = t.x + t.w / 2;
          const cy = t.y + t.h / 2;
          if (body.kind === "circle") {
            const r = Math.max(t.w, t.h) / 2 + 30;
            for (let i = 0; i <= 16; i++) {
              const a = (i / 8) * Math.PI;
              enqueueMove(cx + r * Math.cos(a), cy + r * Math.sin(a), 120);
            }
          } else if (body.kind === "wave") {
            for (let i = 0; i < 6; i++) {
              enqueueMove(cx + (i % 2 ? 25 : -25), cy, 160);
            }
          } else {
            // point: approach then nudge
            enqueueMove(cx + 18, cy + 18, 700);
            for (let i = 0; i < 3; i++) {
              enqueueMove(cx + 6, cy + 6, 150);
              enqueueMove(cx + 14, cy + 14, 150);
            }
          }
          return respond(200, { ok: true });
        }
        if (url.pathname === "/ack") {
          for (const id of body.ids || []) {
            const el = getEl(id);
            if (el) seen.set(id, el.version);
          }
          saveSeen();
          if (body.glance && body.ids?.length) {
            const t = bbox(getEl(body.ids[0]));
            if (t) enqueueMove(t.x + t.w / 2 + 25, t.y - 15, 700);
          }
          return respond(200, { ok: true, seen: body.ids?.length || 0 });
        }
        if (url.pathname === "/save") {
          await mergeSaveScene(roomId, roomKey, client.getElements());
          state.dirty = false;
          return respond(200, { ok: true });
        }
        if (url.pathname === "/quit") {
          respond(200, { ok: true });
          setTimeout(() => process.exit(0), 200);
          return;
        }
      }
      respond(404, { error: "not found" });
    } catch (err) {
      respond(500, { error: err.message });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  fs.writeFileSync(
    infoPath,
    JSON.stringify({ agent, roomId, port, pid: process.pid, color, slot, startedAt: Date.now() }, null, 2),
  );
  logEvent(`daemon listening on 127.0.0.1:${port}`);
  return { port };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
