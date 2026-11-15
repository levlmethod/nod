# Watchers run in code and open cards directly

Watchers check client thresholds every hour without a model. They are an hourly timer in a fork-only module (`src/server/agents/watchers.ts`), not upstream schedules, because an upstream schedule fire is a model turn and the spec requires no model request when nothing trips. The thresholds and the pure check live in `src/server/agents/thresholds.ts` and are part of the client file schema.

A watcher reads through the client's own MCP connection with upstream's `discovered.execute`, after a read-only check on the tool. An anomaly opens a card by inserting the task, its first turn (source `event`, with no owner message, so the trust check sees the notification rule as for other work Nod starts on its own) and its `agent_cards` row in one transaction, plus a fork-only `watcher_cards` row keyed by the anomaly. An advisory lock on the key keeps two runs from opening two cards. A key holds after its card closes until a check finds the metric back inside its threshold, as upstream matters hold until their condition changes.

Watcher reads skip upstream's trust check, which would be a model request each hour. The exact tool and input come from the owner's client file in git, which agents can't write, and code refuses any tool that isn't named as a read or that its server hints writes. Watchers keep running when private preparation is paused, like owner-created schedules, because the owner configured them.

## Upstream files touched

- `src/server/composition.ts`: creates the watchers, starts their timer when the app is ready and stops it on close.

## Considered options

Letting the Router or a watcher agent decide whether to open a card was rejected: it would spend a model request every hour. Opening the card through upstream's `task start` was rejected because it needs a running turn and an owner message; inserting the rows directly keeps upstream's task code unchanged.
