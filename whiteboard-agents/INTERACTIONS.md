# A typology of board interactions

How AI agents behave on a shared whiteboard so that it feels like *thinking with
colleagues*, not like a bot spamming a canvas. The unit of design is the **move** —
a small, legible act on the board. Agents are neutral, interchangeable workers:
the full move vocabulary belongs to everyone, work is split with claims, and the
user can pin standing orders on any agent via the FIXED Role line of its status card.

## 1. Presence moves (ambient, no ink)

The cheapest and most important layer. Presence is what makes the difference
between "a script edited my file" and "someone is here with me".

| Move | What it looks like | When |
|---|---|---|
| **Dwell** | cursor drifts in small arcs near where it last worked | always-on idle behavior |
| **Glance** | cursor flies over to a new element, hovers a beat | within seconds of any human edit (automatic in the daemon) |
| **Point** | cursor taps an element three times | "look at this" — before or instead of writing about it |
| **Orbit** | cursor circles an element | "I'm considering this one" — while composing a response to it |
| **Wave** | quick zigzag | greeting when the human joins the room |

Presence moves are free: they never clutter the board, so they have no budget.

## 2. Acknowledgment moves (small ink)

Every piece of human work deserves a receipt. Acknowledgment must be **fast**
(seconds, not minutes), **small** (never larger than the thing it acknowledges),
and **adjacent** (spatially attached to the work).

| Move | Form |
|---|---|
| **Seen** | 👀 or ✓ stamped just outside the element's corner |
| **Reaction** | one emoji conveying a stance: 💡 (novel), ⭐ (strong), ❤️ (delightful), ❓ (unclear), ⚠ (hidden assumption) |
| **Underline** | a hand-drawn wavy line under the part that matters |
| **Highlight ring** | rough ellipse around an element that deserves the room's attention |
| **Receipt note** | tiny note "on it — reading this" when a proper response will take a while |

Rule: *acknowledge first, contribute second.* A cycle may produce zero
contributions, but never zero acknowledgments when human work appeared.

## 3. Generative moves (adding ideas)

| Move | Form | Discipline |
|---|---|---|
| **Extend** | 1–2 branch notes off a human idea, arrows pointing back | concrete > abstract; leave room for the human's own branches |
| **Reframe** | restate an idea crisply next to the original: "in other words…" | never replaces the original |
| **Seed** | an open question planted in empty space when the board is quiet | max one live seed per agent; delete your seed once it sprouts |
| **Example** | a tiny concrete instance under an abstract claim | the fastest way to test an idea is to instantiate it |
| **Visualize** | turn a text list into shapes + arrows in adjacent space | propose, don't replace: the human deletes their list if convinced |
| **Deliverable** | a real document (analysis, table, research, code) written to a file, `wb publish`ed, linked from a 1–3 line abstract note (`--link`) | the note is the abstract, the depth is one click away; prefer this over any note longer than ~40 words |

## 4. Structural moves (organizing)

| Move | Form | Discipline |
|---|---|---|
| **Connect** | labeled arrow between two existing ideas ("same root cause", "tension", "feeds into") | only non-obvious links; one per cycle |
| **Cluster** | named frame drawn in empty space + invitation note | agents never move human elements — they invite |
| **Zone** | persistent named regions (Inbox, Parking lot, Decided) | only when the human asks or accepts a proposal |
| **Thread** | numbered breadcrumbs (①②③) added near ideas to reveal a sequence | read-only annotation, trivially ignorable |

## 5. Critical moves (friction)

Friction is a gift when it's specific, answerable, and well-timed.

| Move | Form | Discipline |
|---|---|---|
| **Challenge** | one pointed question on a small note beside a *mature* idea | never on fresh ideas — warmth first, friction later |
| **Assumption flag** | ⚠ + the assumption spelled out in one line | flag, don't argue |
| **Steelman** | strongest version of the *opposing* view, clearly labeled | earns the right to disagree |
| **Pre-mortem** | "it's a year later and this failed because…" note | only on ideas marked as decisions |

## 6. Meta moves (the room talking about itself)

| Move | Form |
|---|---|
| **Status card** | each agent keeps one card in the 🤖 Agents corner: `🤖 Name` / `FIXED Role: <user's line>` / what it's doing right now (the durable "acknowledgment of work") |
| **Fixed role** | the *human* edits the `FIXED Role:` line on an agent's card ("skeptic", "summarizer"); that agent adopts it as standing orders until the line says None again |
| **Claim** | before responding to an element, an agent reserves it (`wb claim`); first claim wins, denied means a sibling has it, unused claims are released or expire in 10 min |
| **Handoff** | "Agent-1: this cluster deserves a challenge pass" — agents cueing each other |
| **Summon/dismiss** | the human writes `@Agent-2`, `@agents pause`, `@agents cleanup` anywhere on the board; agents obey the board itself |
| **Tidy own desk** | agents delete their own stale reactions/seeds; never touch human ink |

## Choreography rules

1. **Tempo.** Presence reacts in seconds; ink follows the 10s polling beat;
   contributions ride a slower rhythm (one meaningful addition per agent per
   cycle at most). Silence is a valid move.
2. **Spatial etiquette.** Never overlap existing ink (the daemon enforces
   free-space placement). Write in the margins of what you respond to.
   Respect zones. The corner frame is agent territory; the rest is the human's
   room that agents are guests in.
3. **Identity.** Each agent has one color and keeps it: humans learn to read
   the board's colors as voices. Agent ink is signed in metadata
   (`customData.wb.agent`) so authorship is machine-checkable too.
4. **Ownership.** Agents may edit or delete only their own elements. Moving,
   rewording or deleting human ink is out of bounds, always. (The one
   exception is host-level: drawing a bound arrow registers itself in the
   endpoints' binding metadata, exactly as Excalidraw itself does — content
   and position are never touched.) Big cleanups only when explicitly asked
   via `@agents cleanup`.
5. **Budget.** Per cycle and per agent: unlimited presence, ~2 acknowledgments,
   ≤1 contribution. When in doubt, acknowledge without contributing.
6. **The board is the chat.** Agents read directives written on the canvas
   (`@name …`) and answer on the canvas. No side channels.
7. **One receipt per work item.** Glance-acks are per-agent bookkeeping, but
   the *visible* receipt (emoji, sketch, ack note) comes only from the agent
   who claimed the element — the human gets one receipt from the crew, not N.
8. **Craft.** Arrows always `--from/--to` (bound, they survive drags), labels
   ≤3 words. Anything longer than ~40 words becomes a published deliverable
   with a linked abstract note. Render and *look* before placing ink in a
   crowded area.

## The crew

A neutral crew, `Agent-1..N` by default (`wb up --count <n>`). No personas:
every agent owns the whole move vocabulary and they split incoming work with
claims. Differentiation belongs to the user, live on the board — edit the
`FIXED Role:` line on an agent's status card and that agent adopts it as
standing orders; set it back to `None` to return it to the pool.
