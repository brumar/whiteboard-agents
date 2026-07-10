// Room host: ONE process per room hosting N agent identities.
// Each agent keeps its own socket (cursor identity on excalidraw.com is keyed
// by socket), but they share a single scene store, a single diff engine with
// per-agent seen maps, one persistence writer, and one localhost HTTP API
// (routes take ?agent= / body.agent). Replaces the one-process-per-agent
// daemon; lib/daemon.js remains as a single-agent wrapper.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ExcalidrawClient } from "./client.js";
import { loadScene, mergeSaveScene, getSceneVersion } from "./persistence.js";
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

export const HOST_VERSION = 2; // bumped on breaking info-file / API changes

const POLL_MS = 10_000; // fallback sweep cadence (waiters resolve from the debounce first)
const DEBOUNCE_MS = Number(process.env.WB_DEBOUNCE_MS || 1500); // quiet window after a change
const CURSOR_FPS_MS = 66; // ~15fps cursor animation frames
const DRIFT_BASE_MS = Number(process.env.WB_DRIFT_MS || 3500); // idle-drift cadence
const PRESENCE_TTL_MS = 60_000; // how long a peer sighting counts as "present"
const TOMBSTONE_MS = Number(process.env.WB_TOMBSTONE_MS || 24 * 3600 * 1000); // compaction horizon
const CORNER = { x: -560, y: -460 }; // Agents' Corner (status cards)
const NO_PERSIST = process.env.WB_NO_PERSIST === "1"; // tests: no Firestore traffic
const SPAWN_COOLDOWN_MS = Number(process.env.WB_SPAWN_COOLDOWN || 120) * 1000; // --on-change single-flight
const OPS_PER_MIN = Number(process.env.WB_OPS_PER_MIN || 30); // politeness: ops budget per agent
const SAVE_MIN_SPACING_MS = Number(process.env.WB_SAVE_SPACING_MS || 5000); // Firestore write spacing
const JOURNAL_MAX_BYTES = 10 * 1024 * 1024; // rotate journal.jsonl at 10 MB
const DEFAULT_COLOR = "#1971c2";
const DEFAULT_BG = "#a5d8ff";

export async function runRoomHost(opts) {
  const { roomId, roomKey, agents: initialAgents = [], stateDir } = opts;
  const onChange = opts.onChange || process.env.WB_ON_CHANGE || null;
  if (!initialAgents.length) throw new Error("room host needs at least one agent");

  const dir = path.join(stateDir, roomId);
  fs.mkdirSync(dir, { recursive: true });
  const roomInfoPath = path.join(dir, "room.json");

  // the room key stops living in argv: persist it (0600) so every later
  // command can address the room by bare id (P10)
  const keyPath = path.join(dir, "room.key");
  try {
    fs.writeFileSync(keyPath, roomKey, { mode: 0o600 });
  } catch {}

  const scene = new Map(); // ONE reconciled store shared by every socket
  const agents = new Map(); // name -> agent record
  let primary = null; // the agent whose socket processes scene traffic

  let port = null; // set once the HTTP server listens (bottom of this function)

  const state = {
    peers: new Map(), // username -> {x, y, ts} from MOUSE_LOCATION/IDLE_STATUS
    dirty: false,
    lastForeign: null, // last foreign element added (for auto-glance)
    startedAt: Date.now(),
    paused: false, // set by an @agents stop|pause board directive
    pendingSpawnReason: null, // human-change|directive, consumed by --on-change
  };

  // the room key never reaches logs or error output
  const redact = (s) => String(s).replaceAll(roomKey, "…");
  const logEvent = (msg) => console.log(new Date().toISOString(), redact(msg));

  // ---- session journal (P9b): the durable artifact of a board session ---------
  const journalPath = path.join(dir, "journal.jsonl");
  const journal = (entry) => {
    try {
      if (fs.existsSync(journalPath) && fs.statSync(journalPath).size > JOURNAL_MAX_BYTES) {
        fs.renameSync(journalPath, `${journalPath}.1`);
      }
      fs.appendFileSync(journalPath, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
    } catch {}
  };

  // ---- authorship & summaries ----------------------------------------------
  const authorOf = (el) => el?.customData?.wb?.agent || "human";

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

  const getElements = ({ includeDeleted = true } = {}) => {
    const els = [...scene.values()];
    const live = includeDeleted ? els : els.filter((e) => !e.isDeleted);
    return live.sort((a, b) =>
      (a.index || "") < (b.index || "") ? -1 : (a.index || "") > (b.index || "") ? 1 : 0,
    );
  };
  const liveElements = () => getElements({ includeDeleted: false });
  const getEl = (id) => scene.get(id);

  // ---- per-agent diff engine ------------------------------------------------
  const computeDiff = (agent) => {
    const changes = [];
    for (const el of getElements()) {
      if (authorOf(el) === agent.name) continue;
      // sibling agents' status cards are ledger, not content — auto-ack them
      if (el.customData?.wb?.kind === "status" || el.id === "wb-agents-corner") {
        agent.seen.set(el.id, el.version);
        continue;
      }
      const seenV = Number(agent.seen.get(el.id) ?? -1);
      if ((el.version ?? 0) > seenV) changes.push(summarize(el));
    }
    return changes;
  };

  // ---- peer presence ---------------------------------------------------------
  const isHumanName = (name) => !!name && !String(name).startsWith("🤖 ");
  const prunePeers = () => {
    for (const [name, p] of state.peers) {
      if (Date.now() - p.ts > PRESENCE_TTL_MS) state.peers.delete(name);
    }
  };
  const humansPresent = () => {
    prunePeers();
    return [...state.peers.keys()].some(isHumanName);
  };
  const sawPeer = (username, pointer) => {
    if (!username) return;
    const prev = state.peers.get(username) || {};
    state.peers.set(username, {
      x: pointer ? Math.round(pointer.x) : prev.x,
      y: pointer ? Math.round(pointer.y) : prev.y,
      ts: Date.now(),
    });
    if (isHumanName(username)) startAnimLoop();
  };

  // ---- board directives (P7) -------------------------------------------------
  // Human text starting with @agents or @<AgentName> steers the room from the
  // canvas. stop/pause/resume are handled by the host itself; everything else
  // is surfaced to brains as `directives` in /diff and /wait.
  const directives = new Map(); // elementId -> {id, target, verb, text, x, y}

  function parseDirective(el) {
    if (!el || el.type !== "text" || el.isDeleted) return null;
    if (el.customData?.wb) return null; // agent ink can't steer
    const text = String(el.originalText ?? el.text ?? "").trim();
    const m = text.match(/^@(\S+)\b\s*(\S+)?/);
    if (!m) return null;
    let target;
    if (/^agents$/i.test(m[1])) target = "agents";
    else {
      const hit = [...agents.keys()].find((n) => n.toLowerCase() === m[1].toLowerCase());
      if (!hit) return null; // mention of someone not in the cast
      target = hit;
    }
    return {
      id: el.id,
      target,
      verb: (m[2] || "").toLowerCase() || null,
      text,
      x: Math.round(el.x),
      y: Math.round(el.y),
    };
  }

  async function pauseHost(reason) {
    if (state.paused) return;
    state.paused = true;
    stopAnimLoop();
    for (const agent of agents.values()) {
      agent.animQueue.length = 0;
      agent.animCurrent = null;
    }
    logEvent(`paused (${reason})`);
    for (const agent of agents.values()) {
      try {
        await applyOp(agent, { op: "status", text: "paused by board" });
      } catch (err) {
        logEvent(`status update failed for ${agent.name}: ${err.message}`);
      }
    }
  }

  async function resumeHost() {
    if (!state.paused) return;
    state.paused = false;
    startAnimLoop();
    logEvent("resumed by board");
    for (const agent of agents.values()) {
      try {
        await applyOp(agent, { op: "status", text: "resumed" });
      } catch (err) {
        logEvent(`status update failed for ${agent.name}: ${err.message}`);
      }
    }
  }

  const journalDirective = (d, handled) =>
    journal({
      agent: "human",
      event: "directive",
      ids: [d.id],
      summary: `${d.text}${handled ? " (handled by host)" : ""}`,
    });

  function handleDirective(d) {
    if (d.target === "agents" && (d.verb === "stop" || d.verb === "pause")) {
      for (const agent of agents.values()) agent.seen.set(d.id, getEl(d.id)?.version ?? 0);
      journalDirective(d, true);
      pauseHost(`board directive: ${d.text}`);
      return;
    }
    if (d.target === "agents" && d.verb === "resume") {
      for (const agent of agents.values()) agent.seen.set(d.id, getEl(d.id)?.version ?? 0);
      directives.delete(d.id);
      journalDirective(d, true);
      resumeHost();
      return;
    }
    if (!directives.has(d.id)) journalDirective(d, false);
    directives.set(d.id, d); // cleanup / summons / free-form: brains act on these
  }

  const directivesFor = (agent) =>
    [...directives.values()].filter(
      (d) => !getEl(d.id)?.isDeleted && (d.target === "agents" || d.target === agent?.name),
    );

  // ---- scene events (wired to the primary socket only) -----------------------
  function wireSceneEvents(client) {
    client.on("scene-changed", (els) => {
      state.dirty = true; // the 60s dirty sweep persists foreign changes
      let sawDirective = false;
      for (const el of els) {
        const d = parseDirective(el);
        if (d) {
          sawDirective = true;
          handleDirective(d);
        } else if (directives.has(el.id)) {
          directives.delete(el.id); // deleted or edited away
        }
      }
      const humanEls = els.filter((e) => authorOf(e) === "human");
      if (humanEls.length) {
        journal({
          agent: "human",
          event: "op",
          ids: humanEls.map((e) => e.id),
          summary: humanEls.map((e) => e.type).join(","),
        });
      }
      if (sawDirective) state.pendingSpawnReason = "directive";
      else if (humanEls.length && !state.pendingSpawnReason) state.pendingSpawnReason = "human-change";
      scheduleWake();
      pushSceneToViewers();
      if (state.paused) return; // parked: no glances while paused
      const foreignFor = new Map(); // per glancing agent
      for (const agent of agents.values()) {
        const foreign = els.filter((e) => authorOf(e) !== agent.name);
        if (foreign.length) foreignFor.set(agent, foreign);
      }
      const foreignToAll = els.filter((e) => authorOf(e) === "human" || !agents.has(authorOf(e)));
      if (foreignToAll.length) {
        state.lastForeign = { els: foreignToAll.map(summarize), ts: Date.now() };
      }
      // presence: every agent glances toward the newest element it didn't write
      for (const [agent, foreign] of foreignFor) {
        const el = foreign[foreign.length - 1];
        if (el && Number.isFinite(el.x)) {
          enqueueMove(agent, el.x + (el.width || 0) / 2 + 30, el.y - 20, 900);
        }
      }
    });
    client.on("pointer", (p) => sawPeer(p.username, p.pointer));
    client.on("idle-status", (s) => sawPeer(s.username, null));
    client.on("disconnect", (reason) => logEvent(`primary socket disconnected: ${reason} (auto-reconnects)`));
  }

  // ---- agent lifecycle --------------------------------------------------------
  async function addAgent({ name, color, background, slot }) {
    if (!name) throw new Error("agent needs a name");
    if (agents.has(name)) return agents.get(name);
    const seenPath = path.join(dir, `${name}.seen.json`);
    const seen = new Map(
      fs.existsSync(seenPath) ? Object.entries(JSON.parse(fs.readFileSync(seenPath, "utf8"))) : [],
    );
    const resolvedSlot = Number.isFinite(Number(slot)) ? Number(slot) : agents.size;
    const agent = {
      name,
      color: color || DEFAULT_COLOR,
      background: background || DEFAULT_BG,
      slot: resolvedSlot,
      seen,
      seenPath,
      client: new ExcalidrawClient({
        roomId,
        roomKey,
        username: `🤖 ${name}`,
        scene,
        sceneReadOnly: !!primary, // only the first socket processes scene traffic
      }),
      cursor: { x: CORNER.x + 60 + resolvedSlot * 40, y: CORNER.y + 60 },
      animQueue: [],
      animCurrent: null,
      lastSent: null,
      opBucket: { tokens: OPS_PER_MIN, refilledAt: Date.now() },
    };
    await agent.client.connect();
    agents.set(name, agent);
    if (!primary) {
      primary = agent;
      wireSceneEvents(agent.client);
    }
    writeInfoFiles();
    logEvent(`agent ${name} joined as ${agent.client.socket?.id} (slot ${agent.slot})`);
    journal({ agent: name, event: "join" });
    return agent;
  }

  function saveSeen(agent) {
    fs.writeFileSync(agent.seenPath, JSON.stringify(Object.fromEntries(agent.seen.entries())));
  }

  async function removeAgent(name) {
    const agent = agents.get(name);
    if (!agent) throw new Error(`no such agent: ${name}`);
    saveSeen(agent);
    agent.client.close();
    agents.delete(name);
    const infoPath = path.join(dir, `${name}.json`);
    if (fs.existsSync(infoPath)) fs.unlinkSync(infoPath);
    if (primary === agent) {
      // promote the next identity to scene processing
      primary = agents.values().next().value || null;
      if (primary) {
        primary.client.setSceneReadOnly(false);
        wireSceneEvents(primary.client);
        logEvent(`promoted ${primary.name} to primary socket`);
      }
    }
    writeInfoFiles();
    logEvent(`agent ${name} detached`);
    journal({ agent: name, event: "leave" });
  }

  const resolveAgent = (nameOrNull) => {
    if (nameOrNull) {
      const a = agents.get(nameOrNull);
      if (!a) throw Object.assign(new Error(`unknown agent: ${nameOrNull}`), { status: 404 });
      return a;
    }
    if (agents.size === 1) return agents.values().next().value;
    throw Object.assign(
      new Error(`multiple agents (${[...agents.keys()].join(", ")}) — pass agent`),
      { status: 400 },
    );
  };

  // ---- cursor animation (one loop drives all agents) ---------------------------
  function enqueueMove(agent, x, y, ms = 800) {
    agent.animQueue.push({ x, y, ms });
    if (agent.animQueue.length > 50) agent.animQueue.shift(); // never replay a backlog
  }

  let animFrame = null;
  function startAnimLoop() {
    if (animFrame || state.paused) return;
    animFrame = setInterval(async () => {
      for (const agent of agents.values()) {
        if (!agent.animCurrent) {
          agent.animCurrent = agent.animQueue.shift();
          if (agent.animCurrent) {
            agent.animCurrent.from = { ...agent.cursor };
            agent.animCurrent.t0 = Date.now();
          }
        }
        const cur = agent.animCurrent;
        if (!cur) continue;
        const t = Math.min(1, (Date.now() - cur.t0) / cur.ms);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
        const wobble = Math.sin(t * Math.PI * 3) * 4 * (1 - t);
        agent.cursor.x = cur.from.x + (cur.x - cur.from.x) * e + wobble;
        agent.cursor.y = cur.from.y + (cur.y - cur.from.y) * e - wobble;
        // frame-skip: sub-pixel deltas aren't worth an encrypted broadcast
        if (
          !agent.lastSent ||
          Math.abs(agent.cursor.x - agent.lastSent.x) + Math.abs(agent.cursor.y - agent.lastSent.y) >= 1
        ) {
          agent.lastSent = { ...agent.cursor };
          await agent.client.sendCursor(agent.cursor.x, agent.cursor.y);
        }
        if (t >= 1) agent.animCurrent = null;
      }
    }, CURSOR_FPS_MS);
  }
  function stopAnimLoop() {
    if (!animFrame) return;
    clearInterval(animFrame);
    animFrame = null;
  }
  startAnimLoop();

  // idle drift + presence gate: wander only for humans; park everything otherwise
  setInterval(() => {
    if (!humansPresent()) {
      stopAnimLoop();
      return;
    }
    startAnimLoop();
    for (const agent of agents.values()) {
      if (agent.animQueue.length === 0 && !agent.animCurrent && Math.random() < 0.4) {
        enqueueMove(
          agent,
          agent.cursor.x + (Math.random() - 0.5) * 30,
          agent.cursor.y + (Math.random() - 0.5) * 30,
          1200,
        );
      }
    }
  }, DRIFT_BASE_MS);

  // stay "active" in the collaborators list (cheap keepalive, always on)
  setInterval(() => {
    for (const agent of agents.values()) agent.client.sendIdleStatus("active");
  }, 20_000);

  // ---- persistence: single writer + tombstone compaction ------------------------
  // An isDeleted element can be dropped once it is old enough AND every agent
  // has seen its deletion — nobody's diff still needs it.
  const compactable = (el) =>
    !!el?.isDeleted &&
    Date.now() - (el.updated || 0) >= TOMBSTONE_MS &&
    [...agents.values()].every((a) => Number(a.seen.get(el.id) ?? -1) >= (el.version ?? 0));

  function compactScene() {
    let dropped = 0;
    for (const el of [...scene.values()]) {
      if (compactable(el)) {
        scene.delete(el.id);
        for (const a of agents.values()) a.seen.delete(el.id);
        dropped++;
      }
    }
    if (dropped) logEvent(`compacted ${dropped} tombstoned elements`);
    return dropped;
  }

  let saveTimer = null;
  let lastSaveAt = 0;
  const scheduleSave = (delay = 1500) => {
    state.dirty = true;
    if (NO_PERSIST || saveTimer) return;
    // politeness: never write Firestore more often than SAVE_MIN_SPACING_MS
    const spacing = Math.max(delay, lastSaveAt + SAVE_MIN_SPACING_MS - Date.now());
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      lastSaveAt = Date.now();
      try {
        compactScene();
        await mergeSaveScene(roomId, roomKey, getElements(), { drop: compactable });
        state.dirty = false;
        logEvent("scene persisted");
      } catch (err) {
        logEvent(`persist failed: ${err.message}`);
      }
    }, spacing);
  };
  setInterval(() => {
    if (state.dirty && !saveTimer) scheduleSave(0);
  }, 60_000);

  // ---- element insertion ---------------------------------------------------
  async function insertElements(agent, els) {
    let idx = maxIndex(getElements());
    for (const el of els) {
      if (!el.index) {
        idx = indexAfter(idx);
        el.index = idx;
      }
      el.customData = { ...(el.customData || {}), wb: { agent: agent.name, ...(el.customData?.wb || {}) } };
      agent.seen.set(el.id, el.version); // own work is pre-acked
    }
    // reconcile into the shared store + broadcast through this agent's socket
    for (const el of els) scene.set(el.id, el);
    await agent.client.syncElements(els);
    saveSeen(agent);
    scheduleSave();
    pushSceneToViewers();
    return els.map((e) => e.id);
  }

  function placeNear(targetId, w, h) {
    const anchor = targetId ? bbox(getEl(targetId)) : null;
    const start = anchor ? { x: anchor.x + anchor.w + 40, y: anchor.y } : contentEdge(w, h);
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
  async function applyOp(agent, op) {
    const color = agent.color;
    const background = agent.background;
    switch (op.op) {
      case "note": {
        const width = op.width || 220;
        const pos = op.x != null ? { x: op.x, y: op.y } : placeNear(op.near, width, 100);
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
        await visit(agent, pos.x + width / 2, pos.y - 30);
        return insertElements(agent, els);
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
        await visit(agent, pos.x, pos.y - 30);
        return insertElements(agent, [el]);
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
        return insertElements(agent, created);
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
        await visit(agent, x, y - 20);
        return insertElements(agent, created);
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
        await visit(agent, t.x + t.w / 2, t.y + t.h / 2, 600);
        return insertElements(agent, [el]);
      }
      case "sketch": {
        const t = op.target
          ? bbox(getEl(op.target))
          : { x: op.x, y: op.y, w: op.w || 60, h: op.h || 30 };
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
        await visit(agent, t.x + t.w / 2, t.y + t.h / 2, 600);
        return insertElements(agent, [el]);
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
        return insertElements(agent, [el]);
      }
      case "status": {
        // Agent status card in the Agents' Corner — one per agent, updated in place.
        const cardId = `wb-status-${agent.name}`;
        const existing = getEl(cardId);
        const text = `🤖 ${agent.name}\n${op.text}`;
        if (existing) {
          return patchElement(agent, cardId, { text, originalText: text, ...measureText(text, 14) });
        }
        const el = makeText({
          text,
          x: CORNER.x + 20,
          y: CORNER.y + 30 + agent.slot * 70,
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
        return insertElements(agent, created);
      }
      case "update": {
        const el = getEl(op.id);
        if (!el) throw new Error("update: element not found");
        if (authorOf(el) !== agent.name && !op.force)
          throw new Error("update: refusing to edit non-own element");
        return patchElement(agent, op.id, op.props || {});
      }
      case "delete": {
        const el = getEl(op.id);
        if (!el) throw new Error("delete: element not found");
        if (authorOf(el) !== agent.name && !op.force)
          throw new Error("delete: refusing to delete non-own element");
        return patchElement(agent, op.id, { isDeleted: true });
      }
      case "raw": {
        return insertElements(agent, op.elements);
      }
      default:
        throw new Error(`unknown op: ${op.op}`);
    }
  }

  async function patchElement(agent, id, props) {
    const el = getEl(id);
    const next = {
      ...el,
      ...props,
      version: (el.version || 1) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    };
    scene.set(id, next);
    agent.seen.set(id, next.version);
    await agent.client.syncElements([next]);
    saveSeen(agent);
    scheduleSave();
    pushSceneToViewers();
    return [id];
  }

  async function visit(agent, x, y, ms = 900) {
    enqueueMove(agent, x, y, ms);
    // wait for the move to play out so actions read sequentially
    await new Promise((r) => setTimeout(r, ms + 150));
  }

  // ---- waiters: debounced event wake + fallback sweep --------------------------
  // waiters: Array<{agent, respond, timer}>
  const waiters = [];
  const flushWaiters = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      const diff = computeDiff(w.agent);
      if (!diff.length) continue;
      waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.respond({ changes: diff, ...contextInfo(w.agent) });
    }
  };
  let wakeTimer = null;
  function scheduleWake() {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      const hadListeners = waiters.length > 0;
      flushWaiters();
      // event-spawned brains (P2b): a burst with human changes or directives
      // and nobody long-polling means nobody will act — start a brain.
      const reason = state.pendingSpawnReason;
      state.pendingSpawnReason = null;
      if (reason && !hadListeners) maybeSpawnBrain(reason);
    }, DEBOUNCE_MS);
  }
  setInterval(flushWaiters, POLL_MS); // fallback sweep

  // ---- --on-change brain spawner (single-flight + cooldown) --------------------
  let spawnChild = null;
  let lastSpawnAt = 0;
  let spawnQueuedReason = null;
  function maybeSpawnBrain(reason) {
    if (!onChange || state.paused) return;
    spawnQueuedReason = reason;
    trySpawnBrain();
  }
  function trySpawnBrain() {
    if (!spawnQueuedReason || spawnChild) return; // single-flight
    const wait = SPAWN_COOLDOWN_MS - (Date.now() - lastSpawnAt);
    if (wait > 0) {
      setTimeout(trySpawnBrain, wait + 10);
      return;
    }
    const reason = spawnQueuedReason;
    spawnQueuedReason = null;
    lastSpawnAt = Date.now();
    logEvent(`on-change: spawning brain (${reason})`);
    spawnChild = spawn(onChange, {
      shell: true,
      stdio: "inherit", // lands in host.log
      env: {
        ...process.env,
        WB_ROOM: roomId,
        WB_AGENTS: [...agents.keys()].join(","),
        WB_REASON: reason,
      },
    });
    spawnChild.on("exit", (code) => {
      spawnChild = null;
      logEvent(`on-change: brain exited (${code})`);
      if (spawnQueuedReason) trySpawnBrain();
    });
    spawnChild.on("error", (err) => {
      spawnChild = null;
      logEvent(`on-change: spawn failed: ${err.message}`);
    });
  }

  const contextInfo = (agent) => {
    prunePeers();
    return {
      agent: agent?.name,
      collaborators: (primary || agent)?.client.collaborators.size ?? 0,
      humans: humansPresent(),
      presence: [...state.peers.entries()].map(([name, p]) => ({
        name,
        ...(p.x != null ? { x: p.x, y: p.y } : {}),
        ageSec: Math.round((Date.now() - p.ts) / 1000),
      })),
      ...(agent
        ? { cursor: { x: Math.round(agent.cursor.x), y: Math.round(agent.cursor.y) } }
        : {}),
      sceneVersion: getSceneVersion(getElements()),
      ...(state.paused ? { paused: true } : {}),
      ...(agent && directivesFor(agent).length ? { directives: directivesFor(agent) } : {}),
    };
  };

  // ---- initial scene + agent sockets (subsystems above are ready) ---------------
  if (!NO_PERSIST) {
    try {
      const persisted = await loadScene(roomId, roomKey);
      if (persisted?.elements?.length) {
        for (const el of persisted.elements) if (el?.id) scene.set(el.id, el);
        logEvent(`loaded ${persisted.elements.length} persisted elements`);
      }
    } catch (err) {
      logEvent(`persistence load failed: ${err.message}`);
    }
  }

  for (const spec of initialAgents) await addAgent(spec);
  logEvent(
    `room host up: ${agents.size} agents, ${primary.client.collaborators.size} sockets in room`,
  );

  // directives already on the board (e.g. a standing "@agents pause") apply now
  for (const el of scene.values()) {
    const d = parseDirective(el);
    if (d) handleDirective(d);
  }

  // ---- op rate limiter (P10): encodes politeness, generous by default ----------
  function takeOpTokens(agent, n) {
    const b = agent.opBucket;
    const now = Date.now();
    b.tokens = Math.min(OPS_PER_MIN, b.tokens + ((now - b.refilledAt) / 60_000) * OPS_PER_MIN);
    b.refilledAt = now;
    if (b.tokens < n) {
      const retryAfterSec = Math.ceil(((n - b.tokens) / OPS_PER_MIN) * 60);
      throw Object.assign(new Error(`op rate limit (${OPS_PER_MIN}/min) — retry in ${retryAfterSec}s`), {
        status: 429,
        retryAfterSec,
      });
    }
    b.tokens -= n;
  }

  // ---- live viewer (P9a): /view + SSE /events, read-only ------------------------
  const sseClients = new Set();
  const sseSend = (payload) => {
    if (!sseClients.size) return;
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  function pushSceneToViewers() {
    sseSend({ type: "scene", elements: getElements({ includeDeleted: false }) });
  }
  // cursor stream: agents' animated cursors + human peers, ~7fps, only on movement
  let lastCursorFrame = "";
  setInterval(() => {
    if (!sseClients.size) return;
    prunePeers();
    const cursors = [
      ...[...agents.values()].map((a) => ({
        name: `🤖 ${a.name}`,
        x: Math.round(a.cursor.x),
        y: Math.round(a.cursor.y),
      })),
      ...[...state.peers.entries()]
        .filter(([, p]) => p.x != null)
        .map(([name, p]) => ({ name, x: p.x, y: p.y })),
    ];
    const frame = JSON.stringify(cursors);
    if (frame === lastCursorFrame) return;
    lastCursorFrame = frame;
    sseSend({ type: "cursors", cursors });
  }, 150);

  let viewerAssets = null; // {outDir, bundlePath} once bundled
  async function getViewerAssets() {
    if (!viewerAssets) {
      const { bundleViewer } = await import("./render.js");
      viewerAssets = await bundleViewer();
    }
    return viewerAssets;
  }
  const VIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>wb · ${roomId}</title><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%}</style></head><body><div id="root"></div><script>window.__live=true</script><script src="/app.js"></script></body></html>`;

  function serveViewerAsset(req, res, url) {
    const assetRoot = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "node_modules",
      "@excalidraw",
      "excalidraw",
      "dist",
      "prod",
    );
    let file = null;
    if (url === "/app.js") file = viewerAssets.bundlePath;
    else if (url.startsWith("/assets/")) file = path.join(assetRoot, url.slice(8));
    else file = path.join(viewerAssets.outDir, path.basename(url));
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      if (file.endsWith(".css")) res.setHeader("content-type", "text/css");
      if (file.endsWith(".woff2")) res.setHeader("content-type", "font/woff2");
      res.end(fs.readFileSync(file));
      return true;
    }
    return false;
  }

  // ---- warm renderer (lazy) ----------------------------------------------------
  let renderer = null;
  async function getRenderer() {
    if (process.env.WB_RENDER === "0") throw Object.assign(new Error("rendering disabled (WB_RENDER=0)"), { status: 503 });
    if (!renderer) {
      const { createRenderer } = await import("./render.js");
      renderer = await createRenderer();
      logEvent("warm renderer started");
    }
    return renderer;
  }

  // ---- HTTP API ------------------------------------------------------------------
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
          version: HOST_VERSION,
          roomId,
          // compat: single-agent hosts keep the old field
          ...(agents.size === 1 ? { agent: agents.keys().next().value } : {}),
          agents: [...agents.values()].map((a) => ({
            name: a.name,
            color: a.color,
            slot: a.slot,
            connected: !!a.client.socket?.connected,
            primary: a === primary,
          })),
          connected: !!primary?.client.socket?.connected,
          collaborators: primary?.client.collaborators.size ?? 0,
          elements: liveElements().length,
          uptimeMs: Date.now() - state.startedAt,
        });
      }
      if (req.method === "GET" && url.pathname === "/scene") {
        const full = url.searchParams.get("full") === "1";
        const els = getElements({ includeDeleted: url.searchParams.get("deleted") === "1" });
        let elements = full ? els : els.map(summarize);
        const fields = url.searchParams.get("fields");
        if (fields && !full) {
          const keep = fields.split(",").map((f) => f.trim()).filter(Boolean);
          elements = elements.map((e) =>
            Object.fromEntries(keep.filter((k) => k in e).map((k) => [k, e[k]])),
          );
        }
        const agent = url.searchParams.get("agent")
          ? resolveAgent(url.searchParams.get("agent"))
          : agents.size === 1
            ? resolveAgent(null)
            : null;
        return respond(200, { elements, ...contextInfo(agent) });
      }
      if (req.method === "GET" && url.pathname === "/diff") {
        const agent = resolveAgent(url.searchParams.get("agent"));
        const ctx = contextInfo(agent);
        const since = url.searchParams.get("since");
        if (since !== null && Number(since) === ctx.sceneVersion) {
          return respond(200, { changes: [], ...ctx });
        }
        return respond(200, { changes: computeDiff(agent), ...ctx });
      }
      if (req.method === "GET" && url.pathname === "/wait") {
        const agent = resolveAgent(url.searchParams.get("agent"));
        const timeout = Math.min(300, Number(url.searchParams.get("timeout") || 60)) * 1000;
        const diff = computeDiff(agent);
        if (diff.length) return respond(200, { changes: diff, ...contextInfo(agent) });
        const waiter = {
          agent,
          respond: (obj) => respond(200, obj),
          timer: setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i >= 0) waiters.splice(i, 1);
            respond(200, { changes: [], timedOut: true, ...contextInfo(agent) });
          }, timeout),
        };
        waiters.push(waiter);
        return;
      }
      if (req.method === "GET" && url.pathname === "/render") {
        const r = await getRenderer();
        const crop = url.searchParams.get("crop") || "content";
        const { png, rendered } = await r.render(liveElements(), { crop });
        res.writeHead(200, { "content-type": "image/png", "x-rendered-elements": String(rendered) });
        return res.end(png);
      }
      if (req.method === "GET" && url.pathname === "/view") {
        await getViewerAssets();
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(VIEW_HTML);
      }
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        res.write(
          `data: ${JSON.stringify({ type: "scene", elements: getElements({ includeDeleted: false }) })}\n\n`,
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/journal") {
        const tail = Number(url.searchParams.get("tail") || 100);
        const journalPathNow = fs.existsSync(journalPath) ? journalPath : null;
        const lines = journalPathNow
          ? fs.readFileSync(journalPathNow, "utf8").split("\n").filter(Boolean).slice(-tail)
          : [];
        return respond(200, { entries: lines.map((l) => JSON.parse(l)) });
      }
      // viewer static assets (only once /view has been requested)
      if (req.method === "GET" && viewerAssets && serveViewerAsset(req, res, url.pathname)) {
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const agentName = url.searchParams.get("agent") || body.agent;
        if (url.pathname === "/op") {
          const agent = resolveAgent(agentName);
          const ops = Array.isArray(body.ops) ? body.ops : [body];
          if (state.paused && ops.some((o) => o.op !== "status")) {
            return respond(409, { error: "paused by board directive (@agents resume to continue)" });
          }
          takeOpTokens(agent, ops.length);
          const ids = [];
          for (const op of ops) ids.push(...(await applyOp(agent, op)));
          logEvent(`ops[${agent.name}]: ${ops.map((o) => o.op).join(",")} -> ${ids.join(",")}`);
          journal({ agent: agent.name, event: "op", ids, summary: ops.map((o) => o.op).join(",") });
          return respond(200, { ids });
        }
        if (url.pathname === "/agents") {
          const agent = await addAgent({
            name: body.name,
            color: body.color,
            background: body.bg || body.background,
            slot: body.slot,
          });
          return respond(200, { ok: true, agent: agent.name, slot: agent.slot });
        }
        if (url.pathname === "/cursor") {
          const agent = resolveAgent(agentName);
          if (state.paused) return respond(409, { error: "paused by board directive" });
          let { x, y, ms = 800, target } = body;
          if (target) {
            const t = bbox(getEl(target));
            if (!t) return respond(404, { error: "target not found" });
            x = t.x + t.w / 2;
            y = t.y + t.h / 2;
          }
          startAnimLoop(); // explicit presence request overrides the idle gate
          enqueueMove(agent, x, y, ms);
          return respond(200, { ok: true });
        }
        if (url.pathname === "/gesture") {
          const agent = resolveAgent(agentName);
          if (state.paused) return respond(409, { error: "paused by board directive" });
          startAnimLoop();
          const t = body.target ? bbox(getEl(body.target)) : { x: body.x, y: body.y, w: 0, h: 0 };
          if (!t) return respond(404, { error: "target not found" });
          const cx = t.x + t.w / 2;
          const cy = t.y + t.h / 2;
          if (body.kind === "circle") {
            const r = Math.max(t.w, t.h) / 2 + 30;
            for (let i = 0; i <= 16; i++) {
              const a = (i / 8) * Math.PI;
              enqueueMove(agent, cx + r * Math.cos(a), cy + r * Math.sin(a), 120);
            }
          } else if (body.kind === "wave") {
            for (let i = 0; i < 6; i++) {
              enqueueMove(agent, cx + (i % 2 ? 25 : -25), cy, 160);
            }
          } else {
            // point: approach then nudge
            enqueueMove(agent, cx + 18, cy + 18, 700);
            for (let i = 0; i < 3; i++) {
              enqueueMove(agent, cx + 6, cy + 6, 150);
              enqueueMove(agent, cx + 14, cy + 14, 150);
            }
          }
          return respond(200, { ok: true });
        }
        if (url.pathname === "/ack") {
          const agent = resolveAgent(agentName);
          for (const id of body.ids || []) {
            const el = getEl(id);
            if (el) agent.seen.set(id, el.version);
          }
          saveSeen(agent);
          if (body.glance && body.ids?.length) {
            const t = bbox(getEl(body.ids[0]));
            if (t) enqueueMove(agent, t.x + t.w / 2 + 25, t.y - 15, 700);
          }
          if (body.ids?.length) journal({ agent: agent.name, event: "ack", ids: body.ids });
          return respond(200, { ok: true, seen: body.ids?.length || 0 });
        }
        if (url.pathname === "/save") {
          if (!NO_PERSIST) {
            compactScene();
            await mergeSaveScene(roomId, roomKey, getElements(), { drop: compactable });
            state.dirty = false;
          } else {
            compactScene();
          }
          return respond(200, { ok: true, skipped: NO_PERSIST || undefined });
        }
        if (url.pathname === "/quit") {
          respond(200, { ok: true });
          for (const agent of agents.values()) {
            try {
              saveSeen(agent);
              agent.client.close();
            } catch {}
          }
          if (renderer) await renderer.close().catch(() => {});
          setTimeout(() => process.exit(0), 200);
          return;
        }
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/agents/")) {
        const name = decodeURIComponent(url.pathname.slice("/agents/".length));
        if (agents.size === 1) {
          return respond(400, { error: "last agent — use /quit to stop the host" });
        }
        await removeAgent(name);
        return respond(200, { ok: true });
      }
      respond(404, { error: "not found" });
    } catch (err) {
      if (err.retryAfterSec) res.setHeader("retry-after", String(err.retryAfterSec));
      respond(err.status || 500, { error: redact(err.message) });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;

  function writeInfoFiles() {
    if (!port) return;
    fs.writeFileSync(
      roomInfoPath,
      JSON.stringify(
        {
          version: HOST_VERSION,
          kind: "roomhost",
          roomId,
          port,
          pid: process.pid,
          agents: [...agents.values()].map((a) => ({ name: a.name, color: a.color, slot: a.slot })),
          startedAt: state.startedAt,
        },
        null,
        2,
      ),
    );
    // per-agent info files keep the old `wb` contract working (same port)
    for (const a of agents.values()) {
      fs.writeFileSync(
        path.join(dir, `${a.name}.json`),
        JSON.stringify(
          {
            version: HOST_VERSION,
            agent: a.name,
            roomId,
            port,
            pid: process.pid,
            color: a.color,
            slot: a.slot,
            startedAt: state.startedAt,
          },
          null,
          2,
        ),
      );
    }
  }
  writeInfoFiles();
  logEvent(`room host listening on 127.0.0.1:${port}`);
  return { port, addAgent, removeAgent };
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
