# Implementation pre-plan — round 2 (P4, P7, P10)

Scope decided on 2026-07-11: of the ten round-2 propositions
(PROPOSITIONS-2.md), implement **P4** (agents see images), **P7** (route the
on-change spawner to the right persona) and **P10** (attention-aware
placement — **light bias only**, see the constraint below). Firestore
persistence stays (decision confirmed); P1/P2 remain on the shelf, not
rejected.

## Spike log — live infra re-verified (2026-07-11)

Context: PREPLAN.md's status note said the live excalidraw.com check
("Spike A") could not be run from the dev sandbox. That is no longer true —
re-run successfully on 2026-07-11 from a remote sandbox whose egress goes
through an HTTPS agent proxy, against the existing room
`caf6d3d04dbc0215b9d1` (same room as the 2026-07-10 four-agent session).

Verified, in order, with a single agent (Echo) via `wb start` → `wb stop --all`:

| Assumption | Result |
|---|---|
| websocket to `oss-collab.excalidraw.com` (Origin check, via proxy) | ✅ `connected: true`, socket joined the room |
| Firestore load at host startup | ✅ 10 elements from the 2026-07-10 session recovered intact (status cards, welcome note, Sprout's seed) |
| op round-trip (`note` = container + bound text, `status` updated in place) | ✅ ids returned, elements in `/scene` |
| warm renderer | ✅ 12 elements rendered to PNG, layout correct |
| Firestore merge-save | ✅ `wb save` ok; note visible on next open of the room link |
| clean shutdown | ✅ `wb stop --all`, seen-maps saved |

What this does *not* re-verify live: multi-socket presence (four cursors from
one process, distinct identities in the excalidraw.com UI). That was observed
in the 2026-07-10 session (four daemons, pre-roomhost) and is modeled by the
relay fixture; re-check visually next time a human is in a room with `wb up`.

Practical notes for future spikes: the renderer needs the pre-installed
Chromium (`WB_CHROMIUM` honored, default `/opt/pw-browsers/chromium`);
websockets pass through the agent proxy without any client change.

**Spike C1 outcome (2026-07-11):** ran *partially* live. The compressData
envelope was pinned from the shipped sourcemap of the installed
`@excalidraw/excalidraw` 0.18.1 (`data/encode.ts`, verbatim) rather than from
a live paste — the byte layout is committed as `test/fixtures/room-file.bin`
and asserted offline. Against production: Firebase Storage read path + URL
shape verified (clean JSON 404 for a missing fileId in the known live room,
through the proxy). The full paste-and-read-back script exists as
`test/live-spike-c1.mjs` (drives excalidraw.com in Chromium, drops a PNG,
reads the blob back with lib/files.js) but could not run from this sandbox:
Chromium gets `ERR_CONNECTION_RESET` for **all** external HTTPS through the
agent proxy (curl/Node fetch work; proxy logs only show Chromium's own
`clients2.google.com` background probes being refused). Run it from a less
restricted machine, or simply paste an image next time a human is in a live
room and `wb file` it. `node:zlib` inflate is wire-compatible with pako
(both zlib streams) — the vendoring fallback was not needed.

## The P10 constraint: light bias

Per the review of PROPOSITIONS-2.md: placement should acquire a *light* bias
toward the human's focus, not a new layout engine. Concretely:

- Explicit coordinates (`--x/--y`), explicit anchors (`--near <id>`) and
  directive-answering placement (next to the directive text) are **never**
  altered.
- Only *anchor-less* placement (today: `contentEdge()`) changes: the
  free-space spiral starts near the freshest human pointer instead of the
  content's right edge — when such a pointer exists and is fresh.
- No cursor-following, no re-placement of existing ink, no viewport modeling.
  If it can't be explained in one sentence ("agents start looking for free
  space near where you last pointed"), it's out of scope.

---

Guiding constraints carried over from PREPLAN.md: the CLI surface is the
contract (additive changes only, skills updated in the same commit); `.wb/`
state may be stale mid-upgrade; live infra is for smoke tests only — every
unit test runs against local fixtures. All three phases are additive →
`HOST_VERSION` stays at 2.

## Phase A — persona-routed spawning (P7)

*Goal: `@Grit what breaks this?` wakes Grit, and only Grit.*

Today `maybeSpawnBrain(reason)` receives only `"human-change" | "directive"`;
the parsed directive (target, text) is thrown away, and the spawned command
gets `WB_AGENTS=<everyone>`.

1. **Carry the directive to the spawner.** Replace `state.pendingSpawnReason`
   (string) with `state.pendingSpawn = { reason, targets: Set<string>,
   directive: string|null }`, filled by `handleDirective` for non-host
   directives (`targets.add(d.target === "agents" ? ...all : d.target)`) and
   by the human-change path (empty targets = "let the orchestrator decide").
   Consumed and reset in `scheduleWake` exactly where `pendingSpawnReason` is
   today.
2. **Extend the spawn env** in `trySpawnBrain`: `WB_TARGET` (comma-joined
   summoned agents, empty when unrouted), `WB_DIRECTIVE` (directive text,
   truncated to 200 chars), `WB_REASON` (unchanged). Journal the spawn:
   `{event: "spawn", reason, targets}`.
3. **Cooldown nuance.** Keep single-flight, but a *directive* spawn skips the
   remaining `SPAWN_COOLDOWN_MS` (the human explicitly asked; making them wait
   up to 2 min is worse theater than a second brain). Human-change spawns keep
   the cooldown as-is.
4. **wb-orchestrate skill**: document the routing contract for the
   `--on-change` command — `WB_TARGET` set → launch only those personas'
   wb-agent loops; unset → launch **Echo alone as triage** (Echo acknowledges,
   then uses the existing Handoff move to summon Sprout/Magpie/Grit when the
   board calls for them), instead of the full cast per wake.
5. **Tests** (`test/phase3.test.js` extension): fixture room + stub
   `--on-change` script that dumps its env to a temp file; assert (a)
   `@Grit …` written by a second client yields `WB_TARGET=Grit` and
   `WB_DIRECTIVE`, (b) a plain note yields empty `WB_TARGET`, (c) directive
   spawn bypasses cooldown, human-change spawn does not.

Exit criteria: offline tests green; on a live room, `@Grit …` with
`--on-change` starts exactly one brain with the right env.

## Phase B — light placement bias + focus in context (P10)

*Goal: anchor-less ink lands near where the human is looking; brains can see
where that is.*

The host already tracks every human pointer in `state.peers`
(`{x, y, ts}`); placement just never reads it.

1. **`humanFocus()`** in roomhost.js: freshest entry of `state.peers` whose
   name passes `isHumanName` and whose pointer is younger than
   `WB_FOCUS_TTL_MS` (default 60 s) → `{x, y, ageSec}` or `null`. (Distinct
   from `PRESENCE_TTL_MS`: being *present* lasts longer than being *focus*.)
2. **Bias `placeNear`'s anchor-less branch only**: `placeNear(null, w, h)`
   currently starts the spiral at `contentEdge(w, h)`; start it at
   `humanFocus() + offset (60, 40)` when focus exists, else `contentEdge` as
   today. `findFreeSpace` keeps doing the collision work, so ink appears in
   the first free pocket near the human's attention. The `--near` branch and
   explicit coordinates are untouched (the constraint above).
3. **Expose focus to brains**: `contextInfo()` gains
   `...(humanFocus() ? { focus: {x, y, ageSec} } : {})` — integers, one line,
   consistent with the token-lean API rules (P5, round 1).
4. **Skills**: one paragraph in wb-agent — "prefer `--near <id>`; when you
   write anchor-less ink it now lands near the human's `focus`; use `focus`
   to decide *whether* the human is even looking at the area you're about to
   annotate."
5. **Tests** (unit, no live infra): with a fresh synthetic human pointer and
   no anchor, placement lands within the spiral's first ring of the pointer
   and never overlaps existing ink (reuse `findFreeSpace` assertions); with
   a stale pointer (> TTL) or agents-only peers, behavior is byte-identical
   to today (regression guard); `focus` appears/disappears in `/diff` context
   accordingly.

Exit criteria: offline tests green; manual check on a live room — write a
note far from the content edge, summon an anchor-less seed, it appears
nearby, politely off to the side.

## Phase C — agents see images (P4)

*Goal: a pasted screenshot stops being an opaque `{type: "image"}`.*

The one new subsystem, and the only phase with a real unknown: excalidraw
stores room files encrypted in Firebase Storage
(`files/rooms/<roomId>/<fileId>`), wrapped in its `compressData` envelope
(fflate raw-deflate + a metadata header, see excalidraw's `data/encode.ts` /
`data/FileManager.ts` / `excalidraw-app/data/firebase.ts`). The exact byte
layout is an implementation detail of upstream — pin it down first.

1. **Spike C1 (live, ~30 min).** Paste an image into a throwaway live room
   from excalidraw.com; GET
   `https://firebasestorage.googleapis.com/v0/b/excalidraw-room-persistence.appspot.com/o/files%2Frooms%2F<roomId>%2F<fileId>?alt=media`;
   decode against upstream source (envelope version fields, metadata JSON —
   `mimeType`, `id`, `created` — then ciphertext; AES-GCM with the room key,
   same `crypto.js` scheme). Deliverable: a committed **fixture** (encrypted
   blob + throwaway room key + expected PNG bytes) that makes everything
   after this step offline. Also confirm the live socket protocol never
   carries file bytes (clients fetch from storage on sight of an unknown
   `fileId`) — expected, verify anyway.
2. **`lib/files.js`**: `loadFile(roomId, roomKey, fileId)` →
   `{ mimeType, bytes }`. Decompression via `node:zlib` `inflateRaw` if
   wire-compatible with fflate's output (spike C1 answers this; vendor a
   minimal inflate only if not — keep the zero-runtime-dep property).
   In-memory LRU (≈32 MB) + on-disk cache `.wb/<roomId>/files/<fileId>`
   (covered by the existing `wb down` purge).
3. **Host integration** (roomhost.js):
   - `summarize()`: for `type === "image"`, include `fileId` and
     `hasImage: true` (summaries stay small; no bytes in JSON, ever).
   - New route `GET /file?id=<fileId>` → raw bytes with correct
     content-type; 404 with a clear error when storage has nothing (image
     pasted but never saved, or foreign-room fileId).
   - Prefetch: on `scene-changed`, background-fetch files of new human image
     elements so the first `wb file` / render doesn't pay the network.
     Journal fetch failures.
4. **Renderer**: extend `viewer/app.jsx` `window.__setScene(els, ids, files)`
   to call `api.addFiles(files)` (BinaryFiles: `{id, mimeType, dataURL,
   created}`); `render.js` `render(elements, {crop, files})` passes the
   cached files for visible image elements. `bin/render.js` one-shot: read
   the on-disk file cache when present, else render placeholders as today.
5. **CLI + skills**: `wb file --id <fileId> --out <path>`; wb-agent gains the
   reflex — *diff shows `hasImage: true` → `wb file` → Read the image before
   responding to it* (the brains are multimodal; today they're the only ones
   at the table who can't see the screenshot).
6. **Tests**: `test/files.test.js` — decrypt+decompress round-trip against
   the spike C1 fixture (offline); host route test with a stubbed storage
   fetch (the fixture served over the relay-fixture's HTTP); render smoke
   extended with one image element + a 1×1 PNG.
7. **Non-goal (this round)**: agents *uploading* images. Read-only file
   support ships alone; upload needs the reverse envelope + storage write
   auth and earns its own proposition if wanted.

Exit criteria: offline suite green including the fixture round-trip;
`npm run test:render` shows the pasted image; on a live room, `wb render`
of a board containing a human screenshot renders the screenshot, and a brain
answering `@agents what's in the image?` reads it via `wb file`.

## Order & open decisions

**Order: A → B → C1 (spike) → C.** A and B are small, independent, and
deliver visible behavior on day one; C1 should run early anyway (it's the
only step needing a live room) and can happen right after A. Each phase is
one commit, skills updated in lockstep.

Open decisions to settle at implementation time:

- **A/triage policy**: Echo-as-triage (recommended above) vs waking the full
  cast on unrouted human changes — cost vs liveliness; make it a
  wb-orchestrate parameter rather than host logic.
- **B/`WB_FOCUS_TTL_MS` default**: 60 s proposed; too long and the bias
  points at where the human *was*.
- **C/inflate**: `node:zlib` compat with fflate raw-deflate — fixture
  decides; vendoring fflate (MIT, ~8 kB) is the acceptable fallback.
- **C/cache bounds**: 32 MB memory / unbounded disk proposed; revisit if
  image-heavy rooms show up.
