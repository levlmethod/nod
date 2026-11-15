# The PM scans the board in code and acts through card actions

Every 30 minutes a pg-boss schedule runs a pure scan over a board snapshot of open cards. It flags a card past twice its estimate, a repeated question, an ask over its cap, a loop on the same tool call, spend over the card budget, and a card left open with nothing running for 15 minutes. Only when there are new flags does it start a PM turn, in a background session keyed by the run ID and bound to the `pm` agent. Each flag has a key, saved in `agent_card_activity`, so the same condition is flagged once until it gets worse. A new run waits while the last one is still live.

The PM's only tool is `task`, and in its session only `list` and the PM actions work: `nudge`, `split`, `reassign`, `decide` and `escalate`, each refused for cards its run didn't flag and recorded in the card's activity. `split` resumes the owner agent with the child cards to start, because starting a card needs the card's own running turn. Loop detection needs each call's input, which upstream's `turn_events` don't keep, so the fork stores a hash of each card tool call in `agent_card_calls`.

## Upstream files touched

- `src/server/composition.ts`: creates the PM service, starts its schedule when agents are on, records card tool calls from the runtime's `observe` hook, binds PM sessions to the `pm` agent, and lets the PM's actions handle the `task` tool first.
- `src/runtime/tools.ts` is unchanged: the PM actions join the `task` tool through the card action parameters in `src/shared/cards.ts`.

## Considered options

An upstream schedule was rejected: every fire is a model turn, and the ticket requires no model request when nothing is flagged. Letting the PM start child cards itself was rejected because `task start` runs under the card's own turn lock, and a second path to insert cards would duplicate upstream's task creation.
