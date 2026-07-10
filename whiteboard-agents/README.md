# whiteboard-agents

AI agents with real presence on a live [excalidraw.com](https://excalidraw.com)
whiteboard: named cursors that move, glance at what you write, acknowledge your
work, and think alongside you — each with its own color, temperament, and
repertoire of moves.

```
you (excalidraw.com) ──┐
                       ├── excalidraw-room relay (E2E encrypted)
🤖 Echo   (daemon) ────┤        ▲
🤖 Sprout (daemon) ────┤        │ scene persisted (encrypted) to
🤖 Magpie (daemon) ────┤        ▼ excalidraw's firestore
🤖 Grit   (daemon) ────┘
     ▲ localhost HTTP
     │
  wb CLI  ◄── Claude Code agents (the "brains", one per persona)
```

## What's in the box

- **`lib/`** — a headless Node client for Excalidraw's live-collab protocol:
  - `crypto.js` — the room's AES-GCM-128 E2E encryption (key from the URL fragment)
  - `client.js` — socket.io wire protocol (`SCENE_UPDATE`, `MOUSE_LOCATION`, …), scene reconciliation
  - `elements.js` — wire-valid element factories (notes with bound text, arrows, frames, freedraw), fractional indices, collision-free placement
  - `persistence.js` — read/write the encrypted scene in excalidraw's firestore, so agent work survives everyone going offline
  - `daemon.js` — one process per agent: connection, animated cursor presence
    (eased moves, idle drift, auto-glance at new work), 10s polling diffs,
    ack tracking, localhost HTTP control API
- **`bin/wb.js`** — CLI over the daemon: `start/up/stop`, `scene/diff/wait`,
  `note/text/arrow/react/sketch/status/cursor/gesture/ack/save`
- **`bin/render.js`** — render the board to PNG **offline** through the real
  excalidraw renderer (agents use it to "see" layout; also great for CI)
- **`agents/personas.json`** — the cast: Echo (host/synthesizer), Sprout
  (expander), Magpie (connector), Grit (challenger)
- **`INTERACTIONS.md`** — the design: a typology of board moves (presence,
  acknowledgment, generative, structural, critical, meta) and choreography rules
- **Claude Code skills** (in `../.claude/skills/`): `wb-board` (toolbox),
  `wb-agent` (one persona's loop), `wb-orchestrate` (run the whole cast)

## Quickstart

```bash
cd whiteboard-agents && npm install
```

Put the default cast on your room (or just tell Claude Code: *"put the agents
on my board <link>"* — that's the `wb-orchestrate` skill):

```bash
node bin/wb.js up --room "https://excalidraw.com/#room=<id>,<key>"
node bin/wb.js list
```

Drive an agent by hand:

```bash
node bin/wb.js note  --agent Echo --text "hello from the terminal"
node bin/wb.js react --agent Echo --target <elementId> --emoji "💡"
node bin/wb.js wait  --agent Echo --timeout 60    # block until board activity
node bin/render.js "<room-link>" board.png        # see the board
node bin/wb.js stop --all
```

Daemons keep cursor presence and acknowledge activity automatically; the
*decisions* (what to write, when to challenge, what to connect) are made by
Claude agents running the `wb-agent` loop.

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
- `@Grit what would break this?` — summon one agent to a spot

## Caveats

- The relay accepts any client that knows the room secret; this uses the public
  OSS infra politely (10s polling, throttled cursor frames, merge-writes).
- Excalidraw may evolve its element schema; `bin/render.js` doubles as a
  compatibility test (it restores elements through the real renderer).
- Bound-text sizing is approximated; excalidraw self-corrects on first edit.
