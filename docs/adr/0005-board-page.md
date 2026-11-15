# The Board is a fork-only page over the task ledger and card tables

The Board page reads cards through one fork module, `src/server/agents/board.ts`, which reads the card's task row and current turn, the same fields upstream's task status uses, together with the card service's `cards.read` and the client budget. It adds no state of its own. It doesn't call upstream's `tasks.read`, which stops at the latest 100 tasks. A card's board state follows upstream's task status, except that a card waiting on the owner or closed with a question for the owner is `needs_you`, and otherwise a card with an open blocker is `blocked`. PM actions are stored in the fork table `agent_card_actions`, written through `cards.recordAction`, so the PM (ticket #9) records each nudge, split, reassignment or escalation where the Board shows it.

## Upstream files touched

- `src/server/composition.ts`: registers the board routes.
- `src/server/access.ts`: adds `/board` to the pages a browser may open directly. The `/api/board` routes are covered by the existing `/api` access check.
- `src/web/lib/navigation.ts`: adds the Board item to the sidebar.
- `src/web/app.tsx`: renders the Board page on `/board`.
- `src/web/pages/tasks.tsx`: exports `TaskActivity` so an opened card shows the same activity as a task.

## Considered options

Extending the Scheduled page with card fields was rejected: it would put fork fields through upstream's task component and contracts. Recording PM actions as `turn_events` was rejected, because those belong to turns and the PM acts on cards from its own session.
