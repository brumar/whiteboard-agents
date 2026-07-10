---
name: wb-board
description: Toolbox for interacting with a live Excalidraw whiteboard (excalidraw.com room links) — connect agents, read the board, draw elements, move a presence cursor. Use when the user shares an excalidraw.com/#room=... link or asks about whiteboard agents. For running full AI agents on a board, see wb-orchestrate (multiple) and wb-agent (single persona).
---

# Whiteboard toolbox (Excalidraw live collab)

Everything lives in `whiteboard-agents/` at the repo root. Run all commands from
that directory. One **daemon** per agent holds the socket connection, cursor
presence, scene state, and a localhost HTTP API; the `wb` CLI drives it.

```bash
cd whiteboard-agents && npm install   # first time only
```

## Connect / lifecycle

```bash
node bin/wb.js start --room "<link>" --agent Echo --color "#1971c2" --bg "#a5d8ff" --slot 0
node bin/wb.js up --room "<link>"        # start the whole default cast (agents/personas.json)
node bin/wb.js list                      # who's running
node bin/wb.js health --agent Echo
node bin/wb.js stop --all
```

`<link>` is a full `https://excalidraw.com/#room=<id>,<key>` URL (quote it — `#` and `,`).
All commands below take `--agent <name>` when more than one agent runs.

## Reading the board

```bash
node bin/wb.js scene            # summaries: id, type, text, x/y/w/h, author, version
node bin/wb.js scene --full     # raw excalidraw elements
node bin/wb.js scene --fields id,text,author   # trim summaries to just these keys (cheap reads)
node bin/wb.js diff             # changes by others not yet acked
node bin/wb.js diff --since <sceneVersion>     # tiny answer when nothing changed since your cursor
node bin/wb.js wait --timeout 240   # long-poll: resolves ~2s after the board changes (10s sweep as fallback)
node bin/render.js "<link>" board.png   # render the board to PNG offline (see layout/what the user sees)
```

- `author` is `"human"` for user ink, or an agent name (from `customData.wb.agent`).
- Scene coordinates: y grows downward; the user typically starts around (0,0)–(1000,600).
- Every read returns `sceneVersion` (sum of element versions) — pass it back as `--since` to resume cheaply.
- `wait`/`diff`/`scene` also return `humans` (a human is in the room) and `presence` —
  one `{name, x, y, ageSec}` entry per recently-seen collaborator cursor.

## Acting

```bash
node bin/wb.js ack --ids id1,id2 --glance          # mark seen (+cursor glance)
node bin/wb.js note --text "..." [--near <id>] [--x 100 --y 200] [--bg "#fff9db"] [--ack-of <id>]
node bin/wb.js text --text "..." [--near <id>] [--size 20]
node bin/wb.js arrow --from <id> --to <id> [--label "feeds into"] [--style dashed]
node bin/wb.js react --target <id> --emoji "💡"
node bin/wb.js sketch --kind circle|underline|check --target <id>
node bin/wb.js status --text "watching · last: acked 2 notes"   # agent's card in the 🤖 corner
node bin/wb.js cursor --target <id>                # or --x --y [--ms 800]
node bin/wb.js gesture --kind point|circle|wave --target <id>
node bin/wb.js save                                # force-persist (auto after every op)
```

Complex/batched: `node bin/wb.js op --json '{"ops":[...]}'` with ops
`note | text | shape | arrow | react | sketch | frame | status | update | delete | raw`
(same fields as the flags; `update`/`delete` take `id` and work only on the agent's own elements).

## Behavior built into the daemon (free — don't reimplement)

- Cursor: eased animated movement, idle micro-drift, automatic glance at new foreign elements.
- Placement: notes/text auto-placed in free space (spiral search), never overlapping ink.
- Ordering: fractional indices assigned on insert.
- Sync: full-scene answer to joining users; merge-persist to excalidraw's firestore after each op, so work survives everyone going offline.
- Diff/ack state survives daemon restarts (`.wb/<roomId>/<agent>.seen.json`).

## Rules

- Never `update`/`delete` elements you don't own (the daemon refuses; don't `force` around it on human ink).
- Acknowledge human work before contributing. Presence (cursor) is free; ink has a budget.
- The full interaction grammar and etiquette: `whiteboard-agents/INTERACTIONS.md`.
