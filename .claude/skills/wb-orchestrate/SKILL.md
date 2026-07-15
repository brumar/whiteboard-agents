---
name: wb-orchestrate
description: Put a crew of neutral AI agents on a live Excalidraw whiteboard and keep them running - spawns one wb-agent per crew member (Agent-1..N), each with cursor presence, 10s polling, claim-based work sharing, and a status card whose FIXED Role line the user can edit to pin a role. Use when the user wants agents on their excalidraw.com room ("put the agents on my board", "start the whiteboard crew").
---

# Orchestrate a whiteboard crew

Turns a room link into a living room: several agent daemons (presence) driven by
several Claude subagents (brains). The crew is **neutral and interchangeable** —
no personas. Work is split via claims; the user differentiates agents at
runtime by editing the `FIXED Role:` line on any agent's status card.

Input: an `https://excalidraw.com/#room=<id>,<key>` link. Optional: crew size
(default 3, `--count`), custom names (`--names`), cycle budget per agent
(default 100).

## 1. Bring the daemons up

```bash
cd whiteboard-agents && npm install --silent
node bin/wb.js up --room "<link>" [--count 3]   # ONE room-host carrying the whole crew, idempotent
node bin/wb.js list                             # verify: alive + agents all connected
rm -f .wb/<roomId>/STOP                         # clear any stale stop flag
```

The user should see 🤖 Agent-1..N cursors appear in their room immediately.
Each agent gets a status card in the 🤖 corner reading `FIXED Role: None` —
tell the user they can edit that line anytime to pin a role on an agent
(e.g. `FIXED Role: skeptic`); the host preserves it and routes it to the brain.

## 2. Spawn the brains

For each crew member, launch a **background Agent** (all in one message so they
run concurrently) with a prompt of this shape — identical for every agent
except the name:

> Use the wb-agent skill (read `.claude/skills/wb-agent/SKILL.md` and
> `whiteboard-agents/INTERACTIONS.md` first). You are the board agent
> **Agent-<i>** on room `<link>`. You are a neutral worker: no persona, share
> the workload with your siblings via `wb claim`, adopt the `role` field from
> responses if the user pins one on your card. The daemon is already started.
> Run the wb-agent loop for up to <N> cycles. Never edit human elements. End
> with a one-paragraph report of what happened on the board and what you did.

## 3. Supervise

- Stay responsive to the user; the subagents run the boards.
- Health checks: `node bin/wb.js list`, `wb health`, or render a snapshot
  (`node bin/wb.js render --out /tmp/board.png`, ~300ms warm).
- Relay user wishes by writing to the canvas as any agent (`wb note/text`) or by
  messaging the subagents (SendMessage) — e.g. "user wants more challenge".
  For a *standing* preference on one agent, suggest the user pin it in that
  agent's FIXED Role line instead.
- If a subagent finishes its budget while the session continues, relaunch it.

## 4. Shutdown

```bash
touch whiteboard-agents/.wb/<roomId>/STOP   # brains exit at their next cycle
node bin/wb.js stop --all                   # cursors leave the room
```

The board persists (encrypted) in excalidraw's storage. Report to the user what
each agent did (from their final reports). Files the crew published live on in
`whiteboard-agents/deliverables/<roomId>/`.

## Lazy mode (no parked sessions)

N brains parked on `wait --timeout 240` around the clock is the biggest cost in
the system. When the user wants agents *available* rather than *continuously
thinking*, start the host with an on-change hook and exit:

```bash
node bin/wb.js up --room "<link>" \
  --on-change 'claude -p "Use the wb-agent skill. Board <link> changed (reason: $WB_REASON, summoned: $WB_TARGET, directive: $WB_DIRECTIVE). If WB_TARGET is set, be exactly those agent(s), up to 5 cycles each, then exit. If it is empty, be Agent-1 alone as triage: acknowledge and handle what one agent can; only spin up sibling loops when the change is genuinely multi-part."'
```

The host runs the command only when the board changes **and** no brain
currently holds a `/wait` — single-flight, with a `WB_SPAWN_COOLDOWN`
(default 120 s). A *directive* spawn skips the cooldown, and **editing an
agent's FIXED Role line counts as a directive targeting that agent** — pinning
a role wakes exactly that brain with its new orders.

**Routing contract** (env passed to the command):

- `WB_ROOM`, `WB_AGENTS` — the room id and every agent the host carries.
- `WB_REASON` — `directive` (an `@…` mention or a role edit) or `human-change`.
- `WB_TARGET` — comma-joined summoned agent(s): `Agent-2` for `@Agent-2 …` or a
  role edit on Agent-2's card, the whole crew for `@agents …`, **empty for
  plain human changes**.
- `WB_DIRECTIVE` — the directive text (truncated to 200 chars).

When `WB_TARGET` is empty, prefer waking **one agent as triage** instead of the
full crew per change — with a neutral crew any agent can triage, so use Agent-1
by convention. Waking everyone on every change is a valid but expensive
variation; it's a property of the command you pass, not of the host.

## Variations

- **Solo agent**: skip `up`, use the wb-agent skill directly with one agent
  (`wb start --room "<link>" --agent Agent-1`).
- **Crew size**: `--count <n>` (1–6) or `--names "Ada,Bo,Cy"` for custom names.
  Colors are assigned per slot from a fixed palette.
- **Focused session**: tell each brain the session's topic in its spawn prompt
  ("the user is brainstorming their startup's pricing") so contributions start
  on-theme. For per-agent specialization, don't bake it into prompts — point
  the user at the FIXED Role line, which they keep control of.
