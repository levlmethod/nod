# Cards extend upstream tasks through a side table and two hooks

A card is upstream's task plus a fork-only `agent_cards` row keyed by task ID (owner agent, card type, estimate in agent minutes, budget, structured result). The card service in `src/server/agents/cards.ts` owns the table, and the result contract lives in `src/shared/cards.ts`. Upstream task routing, replies, stop and reopen stay unchanged; a card's session binds its owner agent through the `RuntimeContext.agent` field from ADR 0001.

The card row is written in the same transaction as the task, before its first turn is queued, so a card's first turn can never run unbound with every tool.

## Upstream files touched

- `src/server/tasks.ts`: the `task` input accepts the card fields; `finish.result` becomes optional; an optional `cards` hook runs after a task row is inserted and decides the stored result on `finish`.
- `src/runtime/tools.ts`: the `task` tool schema gains the same optional card fields, and `finish.result` becomes optional.
- `src/runtime/index.ts`: an agent session stays `restricted` unless its tools include `workspace`.
- `src/server/composition.ts`: creates the card service, passes its hooks to tasks, binds a card's owner agent per turn, and skips upstream's auto-close on a final reply for cards.

## Considered options

Wrapping the `task` tool in composition without touching `tasks.ts` was rejected: the card row would be written after the task's transaction commits, so the first turn could start before it and run as plain Nod with every tool.
