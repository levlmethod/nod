# Client walls bind through the agent field and filter the card's context

Each client is a config file under `agents/clients/`, loaded with the agent registry. Every card saves one client on its `agent_cards` row. When a card's session builds a turn, the fork filters the turn's context to that client (its connections, its own session's messages and its client's cards) and drops the owner's memory, which upstream keeps in one tree with no client in it. A `wall` on the `RuntimeContext.agent` field from ADR 0001 refuses tool calls that would cross the wall, with the reason. A client's monthly model spend comes from `model_usage` joined to its cards' sessions, and a card turn of a client at its cap fails before the runtime starts.

## Upstream files touched

- `src/ports/agent.ts`: the optional `agent.wall` (the card's client and a `refuse` check).
- `src/runtime/index.ts`: the tool guard throws the wall's refusal, and memory preparation is skipped for a walled card.
- `src/server/composition.ts`: binds the wall with the agent and runs the client budget check before each card turn.

## Considered options

Splitting upstream's memory tree by client was rejected for Phase 1: memory learning, recall and the memory model all assume one tree per owner, and the change would touch many upstream files. A card instead gets its client's brief from the client file and no shared memory at all, so nothing can leak. Per-client learned memory can come with the Phase 2 knowledge collections.

Pausing a client's turns by leaving them queued was rejected: upstream's queue has no hook for that, and a failed turn with the reason is visible on the card and to the digest.
