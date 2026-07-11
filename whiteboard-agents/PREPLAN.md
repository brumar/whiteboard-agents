# Implementation pre-plan for PROPOSITIONS.md

> **Status (2026-07-10): executed.** All phases (0–5) are implemented on this
> branch, one commit per phase; 69 offline unit tests + a Chromium render
> smoke (`npm run test:render`) are green. Open decisions were settled as:
> node:test, drop `recentPointers` immediately (skills updated in lockstep),
> warm renderer default-on (lazy launch, `WB_RENDER=0` opt-out; measured warm
> ~360 ms), tombstone horizon 24 h without an offline-human guard. Spike A
> (live excalidraw.com multi-socket check) could not be run from the dev
> sandbox — the relay-fixture models it; verify once on a live room.
> **Update 2026-07-11:** the live check now passes from the remote sandbox
> (relay + Firestore + ops + warm render, single agent) — see the spike log
> in PREPLAN-2.md. Multi-cursor presence in the excalidraw.com UI remains
> visually confirmed only from the 2026-07-10 four-daemon session.

Working notes for turning the 10 propositions into changes. Ordered by
dependency and risk, not by proposition number: the safety net comes first,
then behavior-preserving wins, then the one real refactor, then features that
build on it. Proposition numbers (P1–P10) refer to PROPOSITIONS.md.

Guiding constraints:

- **The CLI surface is the contract.** The wb-agent / wb-board / wb-orchestrate
  skills drive everything through `wb <cmd>` and the daemon HTTP API. Every
  phase must keep existing commands and response shapes working (additive
  changes only) until the skills are updated in the same commit.
- **`.wb/` state may be stale mid-upgrade.** Daemons run for days; `wb`
  invocations from a newer checkout must still talk to older running daemons
  or fail with a clear message (add a `version` field to info files early).
- **Live infra is for smoke tests only.** Everything else runs against local
  fixtures so CI and development never depend on excalidraw.com being up or
  polite-usage limits.

---

## Phase 0 — Safety net (P8, part)

*Goal: enough tests that the Phase 2 refactor is mechanical, not scary.*

New dev deps: `vitest` (or node:test, zero-dep — decide at start; leaning
node:test since the project is dependency-light). New top-level `test/` dir.

1. **`test/crypto.test.js`** — encrypt/decrypt round-trip, `parseRoomLink`
   accepted forms, IV length, tamper detection (GCM auth failure).
2. **`test/reconcile.test.js`** — property-style cases for
   `ExcalidrawClient.reconcile`: higher version wins, equal version falls to
   `versionNonce` (mirror excalidraw's exact tie-break: local kept when
   `local.versionNonce <= remote.versionNonce`), idempotence, changed-list
   correctness.
3. **`test/elements.test.js`** — factories from `lib/elements.js` validated
   through `@excalidraw/excalidraw`'s `restoreElements` (import from the dist
   build; this is the schema-drift tripwire). Assert `findFreeSpace` never
   returns an overlapping rect; `edgeToEdge` endpoints land on bboxes.
4. **`test/relay-fixture.js`** — a ~60-line local socket.io server speaking
   the room protocol (`join-room`, `server-broadcast` fan-out,
   `room-user-change`). The client already honors `WB_WS_SERVER`, so no
   production code change is needed to point at it.
5. **`test/client.test.js`** — two `ExcalidrawClient`s against the fixture:
   join, SCENE_UPDATE propagation + decryption, MOUSE_LOCATION volatile path,
   collaborator counting.
6. **`test/daemon.test.js`** — spawn `runDaemon` against the fixture with a
   temp `WB_STATE_DIR`; exercise `/health`, `/op` (note), `/diff`, `/ack`,
   `/wait` timeout path. Firestore calls will fail against the fixture —
   assert the daemon degrades gracefully (it already logs and continues);
   add `WB_NO_PERSIST=1` env to skip persistence in tests.
7. Wire `npm test`; keep `bin/render.js` out of unit tests (it becomes the
   smoke test in Phase 5 CI).

Exit criteria: `npm test` green, offline, < 30 s.

## Phase 1 — Behavior-preserving wins (P2a, P3, P5)

*No architecture change; every daemon API response stays a superset of today's.*

1. **Event-driven `/wait` (P2a).** In `daemon.js`: on `scene-changed`, start a
   quiet-window debounce (default 1.5 s, `WB_DEBOUNCE_MS`); when it fires, run
   the same `computeDiff()` → resolve waiters path the 10 s tick uses. Keep
   the tick as fallback sweep (waiters resolved at most once, whichever fires
   first). `POLL_MS` stays for `diff` semantics; nothing changes for callers
   except latency drops from ≤10 s to ~2 s.
2. **Idle presence throttle (P3).** Daemon tracks `humansPresent` =
   `collaborators.size > agentCount`, where agent sockets are recognized by
   the `🤖 ` username prefix… which the daemon can't see from the socket list
   (it only gets socket ids). Simplest correct source: collaborators map from
   MOUSE_LOCATION/IDLE_STATUS usernames, aged out after 60 s; a peer is human
   if its username lacks the `🤖 ` prefix. When no humans: suspend idle-drift
   timer, drop cursor frames (keep the 20 s `IDLE_STATUS` keepalive), and
   pause the anim loop interval entirely (`clearInterval`, restart on human
   arrival or explicit `/cursor`/`/gesture`). Frame-skip: in the anim loop,
   don't send if `|Δx|+|Δy| < 1`.
3. **Token-lean responses (P5).**
   - Round all coordinates in `summarize()`, `contextInfo()`, pointer records.
   - Replace `recentPointers` array with `presence: [{name, x, y, agesSec}]`,
     one entry per collaborator, ≤1 line each; keep `recentPointers` for one
     release (deprecated) so current skills don't break, then drop when the
     skills are updated (same repo, so: update skills in this commit and drop
     immediately — decision: drop immediately, skills updated in lockstep).
   - `GET /scene?fields=a,b,c` — projection applied after `summarize`.
   - `GET /diff?since=<n>` + `sceneVersion` (sum of versions, already
     implemented as `getSceneVersion` in persistence.js — export and reuse) in
     every response, so brains can cheaply resume.
4. **Skill updates:** wb-board SKILL.md documents `since`/`fields`/`presence`.

Exit criteria: Phase 0 suite green + new tests for debounce (fake timers),
projection, and presence gating; manual live-room check of cursor stillness in
an empty room.

## Phase 2 — The room-host refactor (P1, P4, P6)

*The one structural change. Everything after it gets simpler.*

1. **New `lib/roomhost.js`.** One process per *room*:
   - one `ExcalidrawClient` per agent (cursor identity requires one socket
     each — verified: relay keys cursors by socket id), but **one** shared
     scene `Map`. Refactor `ExcalidrawClient` to accept an injected scene
     store; sockets 2..n subscribe with `sceneReadOnly: true` (they still
     *send* their own cursor frames but their incoming `client-broadcast`
     handlers skip decryption+reconcile — only socket 1 processes scene
     traffic). This is where the 4× decrypt/reconcile saving comes from.
   - one diff engine with per-agent `seen` maps (same `.seen.json` files),
   - one HTTP server: existing routes gain `?agent=` / `"agent"` body field;
     **compat:** also listen per-agent on the old ports? No — instead keep
     one port and have `wb` resolve it from a new `room.json` info file.
     Old `<agent>.json` info files are still written (pointing at the shared
     port) so an old `wb` binary keeps working.
   - **single writer (P4):** one `scheduleSave` for the host. Compaction on
     save: drop elements with `isDeleted` whose `updated` is older than
     `WB_TOMBSTONE_MS` (default 24 h) *and* which every agent has seen.
2. **`bin/wb.js`:** `start` grows `--join` semantics — if a host for the room
   is alive, register the agent with it (`POST /agents {name,color,bg,slot}`)
   instead of spawning; `up` spawns one host with all personas. `stop --agent`
   detaches one identity (socket close) without killing the host; `stop --all`
   kills the host. `list` reads `room.json`.
3. **Dynamic cast becomes possible (nice side effect):** `POST /agents` /
   `DELETE /agents/:name` at runtime.
4. **`wb render` (P6).** Move render.js logic into `lib/render.js`; the host
   owns a lazy warm Chromium (launched on first render, `WB_RENDER=0` to
   disable) and exposes `GET /render?crop=content|frame:<id>` returning PNG.
   `wb render [--out f.png] [--crop content]` calls it; `bin/render.js` stays
   as the standalone/offline path (CI, no daemon running) — it already
   prefers a live daemon, now it just hits `/render`.
5. **Migration:** daemon.js becomes a thin wrapper that starts a single-agent
   room-host (keeps `wb daemon` working); delete the wrapper a release later.

Risks / spikes to do first:
- **Spike A (½ day):** confirm the relay is happy with N sockets from one
  process/IP and that a socket that never sends SCENE_UPDATE still renders a
  cursor. (Strongly expected — excalidraw tabs behave this way — but this is
  the load-bearing assumption of P1.)
- **Spike B:** measure warm-Chromium RSS (~150–250 MB expected); if too heavy
  it stays opt-in behind `WB_RENDER=1` rather than default.

Exit criteria: full test suite green against roomhost; live smoke: `wb up`,
four cursors visible on excalidraw.com, ops from all four agents, one
Firestore writer observed in logs, `wb render` < 500 ms warm.

## Phase 3 — Directives + event-spawned brains (P7, P2b)

*Depends on Phase 2 only for tidiness; could be built on Phase 1 if 2 slips.*

1. **Directive detection (P7).** In the host's reconcile path: text elements
   (human-authored, i.e. no `customData.wb`) matching
   `^@(agents|<AgentName>)\b` become `directives: [{id, target, verb, text,
   x, y}]` in `/diff`/`/wait` responses. Host handles `stop`/`pause`/`resume`
   itself: parks cursors, sets `paused` flag (ops rejected with 409 while
   paused except status), updates status cards to "paused by board". `cleanup`
   and free-form summons are surfaced to brains, not auto-handled.
2. **`--on-change <cmd>` (P2b).** Host-level hook: when a debounced diff
   contains human changes or directives and no brain currently holds a
   `/wait` (i.e. nobody is listening), run `<cmd>` with env
   `WB_ROOM`, `WB_AGENTS`, `WB_REASON`. Single-flight with cooldown
   (`WB_SPAWN_COOLDOWN`, default 120 s) so a chatty board doesn't fork-bomb
   Claude sessions. Document the intended use in wb-orchestrate: the
   orchestrator starts the host with
   `--on-change 'claude -p "/wb-agent ..."'` and exits instead of parking
   four sessions.
3. **Skill rewrite:** wb-agent's loop step 3 ("read directives") consumes the
   structured `directives` field; wb-orchestrate gains the "lazy mode"
   section. This is where the token savings of P2 are actually realized.

Exit criteria: fixture test writing `@agents pause` as a human text element →
host parks + rejects ops; `--on-change` fires exactly once per burst (fake
timers); live smoke with one summon.

## Phase 4 — Viewer, journal, hygiene (P9, P10)

1. **Journal (P9b), first — it's small:** host appends
   `journal.jsonl` per room: `{ts, agent|human, event: op|ack|directive|join|
   leave, ids, summary}`. Rotation at 10 MB. `wb journal [--tail n]` prints it.
   (Human attribution: any reconciled element without `customData.wb`.)
2. **Live viewer (P9a):** host serves the existing viewer bundle at `/view`
   with an SSE stream (`/events`) pushing scene + cursor updates; viewer
   app.jsx gains a ~30-line "live mode" (`?live=1`) that applies them via the
   imperative API. Read-only in v1 (no editing from the viewer — editing goes
   through excalidraw.com; state divergence isn't worth it yet).
3. **Secrets (P10):** key sources in priority order: `--room` link (current,
   kept), `WB_ROOM_KEY` env, `--key-file`. Host persists `{roomId, key}` at
   `.wb/<roomId>/room.key` (0600) at start; every other command accepts a bare
   `--room <id>` and loads the key file, so the key stops appearing in argv
   after the first command. The daemon child no longer receives the key via
   argv — it reads the key file (host writes it before spawn). Redaction pass
   over `logEvent`/`die` (`s.replace(key, '…')`).
4. **Rate limiter (P10):** token bucket in the host: ops (default 30/min/agent),
   cursor frames (already capped by fps), Firestore writes (min 5 s spacing —
   `scheduleSave` mostly does this; make it explicit). 429 with retry-after on
   the HTTP API. Limits configurable, generous — this encodes politeness, it
   shouldn't be felt in normal use.
5. **`wb down`:** stop host + delete `.wb/<roomId>/` (prompt unless `--yes`).

## Phase 5 — CI (P8, rest)

GitHub Actions: `npm test` on node 20/22; render smoke job (chromium via
playwright-core install step or container image) rendering a fixture scene and
asserting non-blank PNG + `rendered == live elements`; weekly scheduled run of
the elements-through-`restoreElements` test against `@excalidraw/excalidraw@latest`
(not the pinned version) as the schema-drift early-warning.

---

## Sequencing & effort (rough)

| Phase | Props | Size | Depends on |
|---|---|---|---|
| 0 tests | P8 | ~1 day | — |
| 1 quick wins | P2a P3 P5 | ~1 day | 0 |
| 2 room-host | P1 P4 P6 | 2–3 days + spikes | 0, 1 |
| 3 directives/spawn | P7 P2b | ~1 day | 1 (ideally 2) |
| 4 viewer/journal/hygiene | P9 P10 | 1–2 days | 2 |
| 5 CI | P8 | ½ day | 0 (smoke needs 2's render split) |

Each phase is one PR; 0+1 could ship together.

## Open decisions (small, can be settled at implementation time)

- node:test vs vitest — leaning **node:test** (zero new deps).
- Drop `recentPointers` immediately vs deprecate — leaning **drop**, skills
  updated in lockstep in the same PR.
- Warm renderer default-on vs opt-in — decide from Spike B memory numbers.
- Tombstone horizon default (24 h?) and whether compaction also needs a
  "human was offline the whole time" guard (a human tab that was offline past
  the horizon could resurrect a compacted element via its own merge-save;
  acceptable — merge keeps highest version, resurrection is harmless noise).

## Out of scope (explicitly)

- Editing from the live viewer.
- Multi-room single host (one host per room stays).
- Any change to the persona format or INTERACTIONS.md choreography rules.
