# 10 propositions to make whiteboard-agents more efficient and useful

Written after reproducing the system end-to-end on 2026-07-10: fresh room,
`wb up` with the default cast (all four daemons connected to the live relay),
notes / arrows / reactions / sketches / status cards driven through the CLI,
cross-agent `diff` + `ack` verified, Firestore save/load round-tripped
(10 elements), and the board rendered offline through the real excalidraw
renderer (10/10 elements). Everything works as documented. The propositions
below come from what the reproduction surfaced.

## Efficiency

### 1. One room-host process, many agent identities

Today each persona is a full Node process with its own socket, its own copy of
the scene, and its own Firestore writer. Every broadcast is therefore decrypted
four times, every reconcile runs four times, and four processes idle at ~50 MB
each. Cursor identity on excalidraw.com is keyed by *socket*, not by process —
so keep one lightweight socket per agent for presence, but host them all in a
single process with one shared scene store, one diff engine, and one HTTP API
(`/op?agent=Echo`). Roughly 4× less memory, CPU, and decryption work, and the
`up`/`stop`/`list` lifecycle gets simpler (one pid, one log).

### 2. Event-driven wake instead of the 10s poll — and brains that sleep

The client already *receives* pushes (`scene-changed` fires the moment a remote
edit arrives); the 10s tick only delays acting on them. Resolve `/wait`
long-polls from a debounced `scene-changed` (e.g. a 1–2 s quiet window to batch
bursts) and keep the tick only as a fallback. Then go further: an
`--on-change <cmd>` daemon hook that spawns a brain (`claude -p` with the
wb-agent skill) only when the board actually changes. Four Claude sessions
parked on `wait --timeout 240` around the clock is the single biggest cost in
the system; event-spawned brains cut it to zero while the board is quiet.

### 3. Cut idle presence traffic

Cursor animation runs at ~15 fps per agent and the idle-drift timer enqueues a
new wander every 3.5–6 s *forever*, even in an empty room — with the default
cast that is a continuous stream of encrypted frames to the public relay with
nobody watching. Presence is for humans: animate only when a human is in the
room (`collaborators > number of agents`), drop to a single keepalive
(`IDLE_STATUS`) otherwise, and skip frames whose position delta is under a
pixel. Same liveliness when it matters, near-zero traffic when it doesn't.

### 4. Elect one persistence writer and compact the scene

All four daemons independently merge-save to Firestore (each `insertElements`
schedules a save, plus a 60 s dirty sweep). Merge-reconciliation makes this
safe but it is 4× the REST writes and a standing race. With proposition 1 —
or, minimally, by convention that slot 0 saves — a single writer suffices.
While saving, compact: tombstoned (`isDeleted`) elements older than some
horizon can be dropped so long-lived rooms don't accumulate unbounded ghosts.

### 5. A token-lean brain API

The daemon's HTTP responses are consumed by LLM contexts, so every byte is a
token bill paid each cycle. Observed in the reproduction: a single `/diff`
carried ten `recentPointers` with 15-decimal floats and repeated usernames.
Round coordinates to integers everywhere, collapse pointers into a one-line
presence summary ("🤖 Sprout + human active near 450,45"), and add
`?fields=id,text,author` projection plus a `diff?since=<sceneVersion>` cursor
so a brain can resume after a gap without re-reading the world.

### 6. Make "seeing" cheap: `wb render` with a warm renderer

`bin/render.js` is the agents' eyes, but every call boots Chromium, rebuilds
state, and serves a one-shot page (seconds of latency, big process churn).
Promote it to `wb render [--crop content|--frame <id>]`, keep one warm
headless browser (in the room-host of proposition 1), and crop the viewport to
the content bbox. When looking costs 200 ms instead of 5 s, brains can afford
to check visual layout *before* placing ink — which is how you stop bad
placements instead of apologizing for them.

## Usefulness

### 7. Directives as first-class daemon events

`@agents stop`, `@agents cleanup`, `@Grit …` are currently discovered by every
brain scanning every diff — so steering only works while a brain happens to be
awake, and each brain re-parses the same text. Let the daemon detect
directive-shaped text and (a) expose it as `directives: [...]` in `/diff` and
`/wait`, (b) honor `stop`/`pause` itself — sign off, park the cursor — even
with no brain attached, and (c) wake only the summoned agent. The
"board-as-chat" promise becomes reliable instead of best-effort.

### 8. A real test suite (the schema will drift)

`npm test` is a stub; the README itself notes that excalidraw may evolve its
element schema and that render.js doubles as the compatibility test. Make that
explicit and cheap to run: unit tests for crypto round-trip and `reconcile`
(version/versionNonce tie-breaks), element factories validated through
excalidraw's own `restoreElements`, a local socket.io relay fixture so
client/daemon tests need no live infra, and the offline render as a CI smoke
test. Today a schema drift is discovered by an agent scribbling garbage on a
live board; a red CI run is a better place to find out.

### 9. Live viewer and a replayable session journal

The viewer bundle already embeds the real renderer for screenshots — serve it
live too: `wb view` opens a localhost page fed from `/scene` over SSE, so the
human can watch the room (and the agents' cursors) without opening
excalidraw.com, and so demos/debugging don't depend on the public site.
Alongside it, have the daemon append a `journal.jsonl` per room (who added
what, acks, directives, timestamps). That journal is the durable artifact a
whiteboard session never has: it can be replayed, diffed, or summarized by an
agent into meeting notes ("what did the room decide?").

### 10. Harden secrets and room hygiene

The room key — the E2E encryption key — currently rides in `argv` (visible in
`ps` on shared machines and re-passed to the spawned daemon) and the full link
sits in shell history. Accept the key via environment variable, stdin, or a
keyfile; store it (0600) in the room's state dir so subsequent commands need
only `--room <id>`; redact it from logs and errors. Add `wb down` to purge a
room's state (`.seen.json`, info files, logs) and, in code rather than by
convention, a polite-mode rate limiter on ops and saves — the README promises
politeness to the public infra; the daemon should be the one keeping it.

---

**Suggested order.** 2 and 5 first (pure cost, no behavior change), then 1+4+6
as one refactor around a room-host process, then 7–10 which each stand alone.
