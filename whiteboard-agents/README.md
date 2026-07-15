# whiteboard-agents

AI agents with real presence on a live [excalidraw.com](https://excalidraw.com)
whiteboard: named cursors that move, glance at what you write, acknowledge your
work, and think alongside you. The crew is neutral and interchangeable — agents
split the incoming work via claims, and each keeps a status card whose
`FIXED Role:` line *you* can edit on the canvas to pin standing orders on it.

```
you (excalidraw.com) ─────────┐
                              ├── excalidraw-room relay (E2E encrypted)
room host ── 🤖 Agent-1 ──────┤        ▲
 (one       ├ 🤖 Agent-2 ─────┤        │ scene persisted (encrypted) to
  process)  └ 🤖 Agent-3 ─────┘        ▼ excalidraw's firestore
     ▲ localhost HTTP           (one socket per agent, one shared scene)
     │
  wb CLI  ◄── Claude Code agents (the "brains", one per crew member)
```

## What's in the box

- **`lib/`** — a headless Node client for Excalidraw's live-collab protocol:
  - `crypto.js` — the room's AES-GCM-128 E2E encryption (key from the URL fragment)
  - `client.js` — socket.io wire protocol (`SCENE_UPDATE`, `MOUSE_LOCATION`, …), scene reconciliation
  - `elements.js` — wire-valid element factories (notes with bound text, arrows, frames, freedraw), fractional indices, collision-free placement
  - `persistence.js` — read/write the encrypted scene in excalidraw's firestore, so agent work survives everyone going offline
  - `roomhost.js` — ONE process per room hosting every agent identity: one
    socket per agent (cursor presence), one shared scene + reconciler, per-agent
    diff/ack tracking, animated cursors (eased moves, idle drift, auto-glance;
    parked when no human is in the room), event-driven `/wait`, single
    persistence writer with tombstone compaction, warm renderer, localhost HTTP
    control API (`daemon.js` is a single-agent compat wrapper)
  - `render.js` — warm headless-Chromium renderer through the real excalidraw
    renderer (~350ms per look once warm), pasted images included
  - `files.js` — room files: fetch + decrypt the binaries excalidraw stores per
    room in Firebase Storage (compressData envelope, format pinned from
    upstream), in-memory LRU + on-disk cache
- **`bin/wb.js`** — CLI over the room host: `start/up/stop`, `scene/diff/wait`,
  `render`, `file`, `note/text/arrow/react/sketch/status/cursor/gesture/ack/claim/publish/save`
- **`bin/render.js`** — one-shot offline render to PNG (prefers a live host's
  warm renderer; also great for CI)
- **`deliverables/<roomId>/`** — rich content the agents publish (analyses,
  research, tables); served by the host at `/d/<name>` so board notes can carry
  clickable localhost links instead of walls of text
- **`INTERACTIONS.md`** — the design: a typology of board moves (presence,
  acknowledgment, generative, structural, critical, meta) and choreography rules
- **Claude Code skills** (in `../.claude/skills/`): `wb-board` (toolbox),
  `wb-agent` (one agent's loop), `wb-orchestrate` (run the whole crew)

## Quickstart

```bash
cd whiteboard-agents && npm install
```

Put a crew on your room (or just tell Claude Code: *"put the agents on my
board <link>"* — that's the `wb-orchestrate` skill):

```bash
node bin/wb.js up --room "https://excalidraw.com/#room=<id>,<key>" [--count 3]
node bin/wb.js list
```

Drive an agent by hand:

```bash
node bin/wb.js note  --agent Agent-1 --text "hello from the terminal"
node bin/wb.js react --agent Agent-1 --target <elementId> --emoji "💡"
node bin/wb.js arrow --agent Agent-1 --from <id> --to <id> --label "feeds into"  # bound: follows drags
node bin/wb.js claim --agent Agent-1 --ids <elementId>   # reserve a work item (siblings get denied)
node bin/wb.js publish --file analysis.md                # → localhost URL for `note --link`
node bin/wb.js wait  --agent Agent-1 --timeout 60  # block until board activity or a role edit
node bin/wb.js render --out board.png             # see the board (~350ms warm)
node bin/wb.js file --id <fileId> --out img.png   # a pasted image, decrypted (hasImage in summaries)
node bin/wb.js stop --agent Agent-1               # detach one agent
node bin/wb.js stop --all                         # stop the room host
```

The room host keeps cursor presence and acknowledges activity automatically; the
*decisions* (what to write, when to challenge, what to connect) are made by
Claude agents running the `wb-agent` loop.

The `wb-*` skills are project-local to this repo. To use them from any
directory, install global copies (paths rewritten to absolute; re-run to
update after editing a skill, `--uninstall` to remove):

```bash
npm run skills:install     # → ~/.claude/skills/wb-{board,agent,orchestrate}
```

## How it talks to excalidraw.com

- Live sync: socket.io against `oss-collab.excalidraw.com` (websocket transport,
  `Origin: https://excalidraw.com` required). Payloads are AES-GCM encrypted with
  the key from the room link — the server never sees plaintext.
- Persistence: the same encrypted scene excalidraw saves to its firestore
  (`scenes/<roomId>`), read/written via REST with merge-reconciliation, so agents
  can work on an empty room and the human sees it all when they reconnect.
- Elements carry `customData.wb = {agent, kind, ackOf}` — authorship and intent
  are machine-readable; anything without it is treated as human ink and never touched.

## Steering from the canvas

The board is the chat. Write anywhere:

- `@agents stop` / `@agents pause` — agents sign off
- `@agents cleanup` — agents delete their own stale reactions/seeds
- `@Agent-2 what would break this?` — summon one agent to a spot
- edit the `FIXED Role:` line on an agent's status card (🤖 corner) — that
  agent adopts the role as standing orders ("skeptic", "summarizer", …) until
  you set it back to `None`; the host preserves your line and wakes the agent

## Caveats

- The relay accepts any client that knows the room secret; this uses the public
  OSS infra politely (event-driven diffs, cursor frames only when a human is in
  the room, one merge-writer per room).
- Excalidraw may evolve its element schema; the test suite validates element
  factories through excalidraw's own `restoreElements` (`npm test`), and
  `npm run test:render` renders a scene through the real renderer offline.
- Bound-text sizing is approximated; excalidraw self-corrects on first edit.
