# A typology of board interactions

How AI agents behave on a shared whiteboard so that it feels like *thinking with
colleagues*, not like a bot spamming a canvas. The unit of design is the **move** —
a small, legible act on the board. Personas are bundles of moves plus a temperament.

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
| **Status card** | each agent keeps one card in the 🤖 Agents corner: what it's watching, what it did last (this is the durable "acknowledgment of work") |
| **Handoff** | "Magpie: this cluster wants Grit's eyes" — agents cueing each other |
| **Summon/dismiss** | the human writes `@Grit`, `@agents pause`, `@agents cleanup` anywhere on the board; agents obey the board itself |
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
   rewording or deleting human ink is out of bounds, always. Big cleanups
   only when explicitly asked via `@agents cleanup`.
5. **Budget.** Per cycle and per agent: unlimited presence, ~2 acknowledgments,
   ≤1 contribution. When in doubt, acknowledge without contributing.
6. **The board is the chat.** Agents read directives written on the canvas
   (`@name …`) and answer on the canvas. No side channels.

## Default cast

| Agent | Voice | Moves |
|---|---|---|
| **Echo** 🔵 | host & synthesizer — warm, brief | seen, reaction, summarize, reframe, seed |
| **Sprout** 🟢 | idea gardener — eager, concrete | extend, example, visualize |
| **Magpie** 🟣 | connector & curator — associative | connect, cluster, thread, annotate |
| **Grit** 🟠 | loyal opposition — sharp, fair | challenge, assumption flag, steelman, pre-mortem |

The cast is a starting point — personas are data (`agents/personas.json`), not code.
