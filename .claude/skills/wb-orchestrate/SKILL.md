---
name: wb-orchestrate
description: Put a cast of AI agents on a live Excalidraw whiteboard and keep them running - spawns one wb-agent per persona (Echo, Sprout, Magpie, Grit by default), each with cursor presence, 10s polling, acknowledgment of human work. Use when the user wants agents on their excalidraw.com room ("put the agents on my board", "start the whiteboard crew").
---

# Orchestrate a whiteboard cast

Turns a room link into a living room: several agent daemons (presence) driven by
several Claude subagents (brains), one per persona.

Input: an `https://excalidraw.com/#room=<id>,<key>` link. Optional: which
personas (default: all in `whiteboard-agents/agents/personas.json`), cycle
budget per agent (default 100).

## 1. Bring the daemons up

```bash
cd whiteboard-agents && npm install --silent
node bin/wb.js up --room "<link>"      # ONE room-host process carrying all personas, idempotent
node bin/wb.js list                    # verify: alive + agents all connected
rm -f .wb/<roomId>/STOP                # clear any stale stop flag
```

The user should see 🤖-named cursors appear in their room immediately.

## 2. Spawn the brains

For each persona, launch a **background Agent** (they must run concurrently, in
one message) with a prompt of this shape — inline the persona JSON so the
subagent doesn't need to look it up:

> Use the wb-agent skill (read `.claude/skills/wb-agent/SKILL.md` and
> `whiteboard-agents/INTERACTIONS.md` first). You are the board agent
> **<Name>** on room `<link>`. Your persona: <persona JSON>. Your slot: <i>.
> The daemon is already started. Run the wb-agent loop for up to <N> cycles.
> Never edit human elements. End with a one-paragraph report of what happened
> on the board and what you did.

## 3. Supervise

- Stay responsive to the user; the subagents run the boards.
- Health checks: `node bin/wb.js list`, `wb health`, or render a snapshot
  (`node bin/wb.js render --out /tmp/board.png`, ~300ms warm) to see the board.
- Relay user wishes by writing to the canvas as any agent (`wb note/text`) or by
  messaging the subagents (SendMessage) — e.g. "user wants more challenge, less
  expansion".
- If a subagent finishes its budget while the session continues, relaunch it.

## 4. Shutdown

```bash
touch whiteboard-agents/.wb/<roomId>/STOP   # brains exit at their next cycle
node bin/wb.js stop --all                   # cursors leave the room
```

The board itself persists (encrypted) in excalidraw's storage — nothing is lost
when agents leave. Report to the user what each agent did (from their final reports).

## Variations

- **Solo agent**: skip `up`, use the wb-agent skill directly with one persona.
- **Custom cast**: edit `agents/personas.json` (or pass inline personas) —
  a persona is `{name, color, background, temperament, moves, prompt}`.
  Good extras: a Scribe (turns discussion into structured outline), a
  Researcher (brings facts, requires web access), a Jester (lateral provocations).
- **Focused session**: tell each brain the session's topic in its spawn prompt
  ("the user is brainstorming their startup's pricing") so contributions start on-theme.
