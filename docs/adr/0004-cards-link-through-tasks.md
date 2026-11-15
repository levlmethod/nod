# Cards link to each other through the task ledger and the turn queue

Child cards, blockers and asks reuse upstream's task sessions and turn queue instead of adding a scheduler. A child card is an ordinary independent task session started from a card session. A blocked card's first turn is queued with `start_after='infinity'`, which upstream's claim query already skips, and is released when its last blocker closes. An ask runs as its own background session keyed by the ask ID, bound to the asked agent, and resumes the asking card through `resumeTurn`. Agent time and waiting-on-owner time are derived from `turns` timestamps and `turn_events`: upstream's `waiting` event marks when a turn stopped for the owner, and the card service adds a `card_question` event when a card closes with a question. Upstream overwrites a waiting turn's `finished_at` when the owner answers, so `finished_at` alone can't tell work from waiting. No second time ledger can drift from the turns that actually ran.

Links respect the client walls of ADR 0003. A child card takes its parent's client, a card can be blocked only by cards of its own client, and an ask session is walled to the client of the card it was asked on, with its spend counted toward that client.

## Upstream files touched

- `src/server/tasks.ts`: `task start` from a card session that names an `agent` starts a child card in its own session instead of being refused, with the brief as its first request; a held card's first turn gets `start_after='infinity'`; the card hook's `closed` runs after a card finishes or is stopped, to release blocked cards and resume parents.
- `src/runtime/tools.ts`: the `task` tool schema gains `blockedBy` on `start` and the `ask` and `answer` actions.
- `src/server/composition.ts`: the `task` tool tries the card service's `ask`, `answer` and ask-session guard first, and the agent binding learns which agent an ask session belongs to.

## Considered options

Holding blocked cards with a fork-only check inside upstream's claim query was rejected: it would put a fork table into upstream's hottest query. A far-future `startAfter` through `enqueueTurn` was rejected because it schedules a queue job for that date.
