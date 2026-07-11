# 10 more propositions — round 2

The first ten propositions (PROPOSITIONS.md, 2026-07-10) are all implemented:
room-host process, event-driven wait, token-lean API, warm renderer, board
directives, journal, live viewer, secrets hygiene, rate limits, offline test
suite. This second round comes from re-reading the implementation as it stands
(`lib/roomhost.js`, `lib/client.js`, `lib/persistence.js`, `lib/elements.js`,
the `wb-*` skills) and asking: where does it still lose data, trust, or
opportunities?

> **Status (2026-07-11):** 4, 7 and 10 are accepted (10 with a *light bias
> only* constraint) — implementation plan in PREPLAN-2.md. Firestore
> persistence is confirmed kept; 1–2 stay relevant but unscheduled.
>
> **Implemented (2026-07-11, same day):** 7 (WB_TARGET/WB_DIRECTIVE routing,
> directive spawns skip the cooldown), 10 (humanFocus() bias on anchor-less
> placement only, `focus` in context payloads), 4 (`lib/files.js` +
> `GET /file` + `wb file`, prefetch on sight, images painted by the warm
> renderer). Offline suite covers all three; the file-envelope format is
> pinned from upstream 0.18.1 source, with a live paste-and-read check still
> to be done next time a human is in a room.

## Robustness

### 1. Resync the scene after a disconnection

`client.js` relies on socket.io auto-reconnect, and on rejoin the scene is
recovered only if another client is online to answer with a `SCENE_INIT`.
The hole: the human edits during a relay blip (or while the host's network is
down) and *leaves before the agents reconnect*. Their edits land in Firestore
via excalidraw.com's own save path, but the host loads Firestore **once at
startup** — so those elements never enter the shared store, never appear in
any `/diff`, and are never acknowledged. Merge-save preserves them (no data
loss) but the agents are blind to them until a restart. Fix: on every
`reconnect` of the primary socket — and as a low-frequency safety sweep (e.g.
every 10 min while no human is present) — `loadScene()` and reconcile into the
store, emitting `scene-changed` for anything new.

### 2. Conditional Firestore writes (stop the lost-update window)

`mergeSaveScene` is load → merge in process → PATCH. Between the load and the
PATCH, any write by excalidraw.com's own client (the human hitting save, or
its periodic sync) is silently overwritten. The Firestore REST API supports
preconditions: send `currentDocument.updateTime=<updateTime from the load>`
and on `FAILED_PRECONDITION` re-load, re-merge, retry (bounded, with jitter).
This turns the merge-writer from "probably fine" into actually race-free —
important now that compaction *drops* elements at save time.

### 3. Authenticate the localhost API — and enforce etiquette in the host

Two trust gaps in `roomhost.js`:

- The HTTP server binds 127.0.0.1 with **no auth**: on a shared machine, any
  local process can read the decrypted scene (`/scene`), drive the agents
  (`/op`), or kill the host (`/quit`). Generate a per-room bearer token at
  startup, store it in the 0600 info files (`wb` reads it from there
  transparently), require it on every route.
- `update`/`delete` accept `force: true`, which lets a caller edit or delete
  **human ink** — the one rule INTERACTIONS.md calls inviolable is only
  enforced by convention in the skills. Since board text is untrusted input to
  the brains (a prompt-injection note could ask an agent to "force-delete
  everything"), the host itself should refuse `force` unless started with an
  explicit `--allow-force` flag. Etiquette that matters belongs in the server,
  not the prompt.

## Capabilities

### 4. Let agents see images (and other binary files) on the board

Humans paste screenshots, diagrams, photos — `image` elements with a `fileId`
pointing at an encrypted blob in excalidraw's Firebase Storage
(`/files/rooms/<roomId>/<fileId>`). Today those elements reach the diff as an
opaque `{type: "image"}`: the agents' single biggest blind spot, and the warm
renderer shows a placeholder for them too. Add `files.js` (fetch + decrypt
with the room key, same AES-GCM scheme), a `GET /file/<id>.png` route, feed
the blobs to the renderer so `wb render` shows what the human sees, and flag
`hasImage: true` in summaries so a brain knows to go look. A pasted
architecture diagram is usually the most information-dense element on the
board — right now it's the only one the agents can't read.

### 5. `wb undo` — journaled, revocable agent work

Trust requires an undo. The journal already records `{agent, event: "op",
ids}` per operation; the host owns every agent element. Add
`wb undo --agent Grit --last 3` and `wb undo --all --since <ts>` (walk the
journal backwards, tombstone via the existing `patchElement` path), plus the
board-side directive `@agents undo` / `@Grit undo` for the human who never
opens a terminal. Cheap to build, and it changes the human's relationship to
the cast: an agent whose mistakes cost one word to erase is an agent you let
write more.

### 6. `wb summary` — turn the journal into the meeting's minutes

The journal was built (P9) as "the durable artifact a whiteboard session never
has", but nothing consumes it yet. Add `wb summary [--since <ts>]`: assemble
journal entries + the live scene (texts with authors, positions, ack/directive
history), emit a structured digest — what appeared, what was decided, what was
challenged and by whom, open seeds — as markdown to stdout. The wb-orchestrate
skill can pipe that through a brain for prose ("what did the room decide?"),
and a session ends with something you can paste into an issue.

### 7. Route the on-change spawner to the right persona

`maybeSpawnBrain` fires one generic `--on-change` command with
`WB_AGENTS=<all>`, even when the trigger was `@Grit what breaks this?` — the
directive's target is known (`handleDirective` parsed it) and then thrown
away. Pass it through: `WB_TARGET=Grit`, `WB_DIRECTIVE=<text>`,
`WB_REASON=directive|human-change`, and let the spawned orchestrator start
*only* the summoned persona (or, for plain human changes, a cheap triage step
that picks who should wake: fresh idea → Sprout, mature cluster → Grit,
scattered notes → Magpie). Four Claude sessions waking for every note is the
current cost profile; one well-chosen brain is both cheaper and better
theater.

### 8. Real text metrics from the warm renderer

`measureText` guesses `0.55 × fontSize` per character, so notes arrive
mis-sized (the README's own caveat: "excalidraw self-corrects on first edit" —
i.e. the board is subtly wrong until a human touches it, and `findFreeSpace`
reserves wrong-sized rectangles). The warm Chromium already has the real
Excalifont and excalidraw's own measurement code: expose a
`measure(text, fontSize, fontFamily)` hook on the renderer, have the host use
it when warm (fallback to the heuristic when not), and bound-text sizing stops
being approximate. Same trick fixes label centering on shapes and arrows.

## Operations & reach

### 9. `wb doctor` and a live canary in CI

The offline suite is green, but every load-bearing external assumption —
relay accepts our Origin header, websocket transport still up,
Firestore API key still valid, element schema unchanged on excalidraw.com,
multi-socket presence still keyed per socket (PREPLAN's Spike A, still never
run against production) — is verified by nothing until an agent scribbles
garbage on a live board. Add `wb doctor`: create a throwaway room, connect
two sockets, exchange one encrypted element, save/load Firestore, render,
report pass/fail per assumption, delete the room. Run it locally before demos
and as an opt-in scheduled CI job (weekly + on `@excalidraw/excalidraw` bumps
via dependabot), so upstream drift is a red run, not a live incident.

### 10. Place ink where the human is looking

`state.peers` already tracks every human cursor position, but placement
(`placeNear` → `contentEdge`) only reasons about content bounds: an agent may
answer a directive with a note two screens away from where the human is
working, and nothing ever hints at *where* the human's attention is. Use the
freshest human pointer as the placement bias — seed `findFreeSpace` near it
when no explicit anchor (`--near`, directive coordinates) exists, prefer free
space on the human-facing side of the anchor otherwise, and include a
one-line `focus: {x, y, ageSec}` in `/diff`/`/wait` context so brains can
reason about attention too. Presence made the agents feel *present*; writing
into the human's field of view is the same courtesy applied to ink.

---

**Suggested order.** 1–2 first (data integrity, small diffs), 3 next (trust
boundary, breaking API change while the surface is young), then 5+6 together
(journal becomes product), 7–8 as quality-of-life for the brains, 4 as the
one new subsystem, 9–10 last (each stands alone).
