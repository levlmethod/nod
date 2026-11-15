# Risk tiers feed the trust check and hold card approvals in a queue

Agents act alone on Tier 1 work and wait for the owner on Tier 2 work. The fork does not replace upstream's trust check: for a card's turn it adds tier rules, written like owner rules, to the rules the checker sees, and a pure tier policy in `src/server/agents/tiers.ts` makes recognised Tier 2 actions ask without a model check. Every approval a card raises is recorded in a fork-only queue with the agent's reasons. Items not marked urgent are held back from browser notifications and chat-app delivery so they wait for the morning digest.

## Upstream files touched

- `src/server/trust.ts`: an optional `tiers` hook returns rules for the turn, joined to the owner's rules for the check only, and an `ask` that skips the model review and asks. Saved instruction changes keep the owner's own rules.
- `src/server/approvals.ts`: an optional `asked` hook runs in the transaction that saves a new approval and its question.
- `src/server/tasks.ts` and `src/runtime/tools.ts`: the `task` update action accepts an optional `approval` note, passed to an `approvalNote` hook.
- `src/server/channels.ts`: an optional `heldMessages` list is left out of the chat-app outbox.
- `src/server/app.ts`, `src/shared/contracts.ts` and `src/web/hooks/use-browser-notifications.ts`: an optional `heldMessages` lookup marks messages `held`, and browser notifications skip them.
- `src/server/composition.ts`: creates the queue, wires the hooks, and appends the tier instructions to a card agent's prompt.

## Considered options

Relying on the tier rules alone was rejected: the trust check is a model, and the owner asked that a Tier 2 action never run without a yes. The code policy only adds questions, so a wrong guess costs a question, not an action.

Hiding queued questions until the digest was rejected: the approval would be invisible on its card, and upstream approvals would have to learn a new state. Holding only the notification keeps the approval card working as upstream built it.
