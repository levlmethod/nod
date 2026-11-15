# The Board is a fork-only page over the task ledger and card tables

The Board page reads cards through one fork module, `src/server/agents/board.ts`, which joins upstream's task ledger (`tasks.read`, for title and status) with the card service's `cards.read` and the client budget. It adds no state of its own. A card's board state is its task status, except that a card with an open blocker is `blocked` and a card closed with a question for the owner is `needs_you`. PM actions are stored in the fork table `agent_card_actions`, written through `cards.recordAction`, so the PM (ticket #9) records each nudge, split, reassignment or escalation where the Board shows it.

## Upstream files touched

- `src/server/composition.ts`: registers the board routes.
- `src/server/access.ts`: adds `/board` to the pages a browser may open directly. The `/api/board` routes are covered by the existing `/api` access check.
- `src/web/lib/navigation.ts`: adds the Board item to the sidebar.
- `src/web/app.tsx`: renders the Board page on `/board`.
- `src/web/pages/tasks.tsx`: exports `TaskActivity` so an opened card shows the same activity as a task.

## Considered options

Extending the Scheduled page with card fields was rejected: it would put fork fields through upstream's task component and contracts. Recording PM actions as `turn_events` was rejected, because those belong to turns and the PM acts on cards from its own session.
