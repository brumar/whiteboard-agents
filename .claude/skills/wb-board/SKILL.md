---
name: wb-board
description: Toolbox for interacting with a live Excalidraw whiteboard (excalidraw.com room links) — connect agents, read the board, draw elements, move a presence cursor. Use when the user shares an excalidraw.com/#room=... link or asks about whiteboard agents. For running full AI agents on a board, see wb-orchestrate (crew) and wb-agent (single agent).
---

# Whiteboard toolbox (Excalidraw live collab)

Everything lives in `whiteboard-agents/` at the repo root. Run all commands from
that directory. One **room host** process per room carries every agent identity
(one socket per agent for cursor presence, one shared scene, one localhost HTTP
API); the `wb` CLI drives it.

```bash
cd whiteboard-agents && npm install   # first time only
```

## Connect / lifecycle

```bash
node bin/wb.js start --room "<link>" --agent Agent-1 --color "#1971c2" --bg "#a5d8ff" --slot 0
node bin/wb.js up --room "<link>" [--count 3 | --names "Ada,Bo"]   # start a neutral crew (default Agent-1..3)
node bin/wb.js list                      # running rooms + their agents
node bin/wb.js health                    # also reports the deliverables dir + /d/ base URL
node bin/wb.js stop --agent Agent-1      # detach one identity (host keeps running)
node bin/wb.js stop --all                # stop the room host (all cursors leave)
```

`start`/`up` are idempotent: if the room's host is already up they join the new
agent(s) to it instead of spawning another process.

`<link>` is a full `https://excalidraw.com/#room=<id>,<key>` URL (quote it — `#` and `,`).
After the first command the key is stored at `.wb/<roomId>/room.key` (0600), so
every later command accepts a bare `--room <id>` — stop passing the key around.
All commands below take `--agent <name>` when more than one agent runs.

## Reading the board

```bash
node bin/wb.js scene            # summaries: id, type, text, x/y/w/h, author, version
node bin/wb.js scene --full     # raw excalidraw elements
node bin/wb.js scene --fields id,text,author   # trim summaries to just these keys (cheap reads)
node bin/wb.js diff             # changes by others not yet acked
node bin/wb.js diff --since <sceneVersion>     # tiny answer when nothing changed since your cursor
node bin/wb.js wait --timeout 240   # long-poll: resolves ~2s after the board changes (10s sweep as fallback)
node bin/wb.js render --out board.png [--crop content|frame:<id>]   # PNG via the host's warm renderer (~300ms)
node bin/wb.js file --id <fileId> [--out img.png]   # fetch+decrypt a pasted image (see hasImage below)
node bin/wb.js view                 # URL of the live read-only viewer (SSE: scene + cursors)
node bin/wb.js journal [--tail 50]  # replayable session journal (ops/acks/directives/joins, jsonl)
node bin/render.js "<link>" board.png   # offline fallback when no host runs (boots its own Chromium)
```

- `author` is `"human"` for user ink, or an agent name (from `customData.wb.agent`).
- Image elements carry `hasImage: true` + `fileId` in summaries. `wb file --id <fileId>`
  saves the decrypted bytes; `wb render` paints them into the board PNG too.
- Scene coordinates: y grows downward; the user typically starts around (0,0)–(1000,600).
- Every read returns `sceneVersion` (sum of element versions) — pass it back as `--since` to resume cheaply.
- `wait`/`diff`/`scene` also return `humans` (a human is in the room) and `presence` —
  one `{name, x, y, ageSec}` entry per recently-seen collaborator cursor.
- When a human pointer moved in the last 60 s (`WB_FOCUS_TTL_MS`), responses also
  carry `focus: {x, y, ageSec}` — where the human is looking. Anchor-less
  `note`/`text`/`shape` ops start their free-space search near `focus`;
  `--near`/`--x/--y` are never altered.

## Acting

```bash
node bin/wb.js ack --ids id1,id2 --glance          # mark seen (+cursor glance)
node bin/wb.js claim --ids id1,id2 [--release]     # reserve work items; {granted, denied} — first claim
                                                   # wins, denied ⇒ a sibling has it, TTL 10 min
node bin/wb.js note --text "..." [--near <id>] [--x 100 --y 200] [--bg "#fff9db"] [--link <url>] [--ack-of <id>]
node bin/wb.js text --text "..." [--near <id>] [--size 20] [--link <url>]
node bin/wb.js arrow --from <id> --to <id> [--label "feeds into"] [--style dashed]
                                                   # binds to both endpoints (follows drags); the label
                                                   # is bound to the arrow and stays centered on it
node bin/wb.js react --target <id> --emoji "💡"
node bin/wb.js sketch --kind circle|underline|check --target <id>
node bin/wb.js status --text "watching · last: acked 2 notes"   # agent's card in the 🤖 corner;
                                                   # its "FIXED Role:" line is the user's and is preserved
node bin/wb.js publish --file <path> [--name x.md] # drop a file in deliverables/<roomId>/, prints the
                                                   # localhost URL to use with --link (rich content pattern)
node bin/wb.js cursor --target <id>                # or --x --y [--ms 800]
node bin/wb.js gesture --kind point|circle|wave --target <id>
node bin/wb.js save                                # force-persist (auto after every op)
```

Complex/batched: `node bin/wb.js op --json '{"ops":[...]}'` with ops
`note | text | shape | arrow | react | sketch | frame | status | update | delete | raw`
(same fields as the flags; `update`/`delete` take `id` and work only on the agent's own elements).

- Every agent-scoped read also returns `role` (the FIXED Role pinned on the
  agent's card, `"None"` by default), the agent's active `claims`, and — right
  after the user edits the role line — `roleChanged: true`. `wait` resolves on
  role edits too, and summaries of claimed elements carry `claimedBy`.

## Behavior built into the daemon (free — don't reimplement)

- Cursor: eased animated movement, idle micro-drift, automatic glance at new foreign elements.
- Placement: notes/text auto-placed in free space (spiral search), never overlapping ink.
- Ordering: fractional indices assigned on insert.
- Sync: full-scene answer to joining users; merge-persist to excalidraw's firestore after each op, so work survives everyone going offline.
- Diff/ack state survives daemon restarts (`.wb/<roomId>/<agent>.seen.json`).

## Rules

- Never `update`/`delete` elements you don't own (the host refuses; don't `force` around it on human ink).
- Acknowledge human work before contributing. Presence (cursor) is free; ink has a budget —
  literally: ops are rate-limited (default 30/min/agent, 429 + retry-after beyond it).
- If a response carries `"paused": true`, a human wrote `@agents stop|pause` on the board:
  stand down until it says otherwise (ops return 409 meanwhile).
- `wb down --room <id> --yes` purges a room's local state (seen maps, key, journal, logs).
- The full interaction grammar and etiquette: `whiteboard-agents/INTERACTIONS.md`.
