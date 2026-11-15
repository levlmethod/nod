# Inbox triage reads through observation sources and opens cards from code

New mail reaches the Inbox agent through a fork-only loop, not through upstream's observer. Every 15 minutes, code reads each inbox named in a client file through upstream's observation sources: Nod's recorded Gmail reader for a connected Gmail account, or a named read tool on another connection, which passes upstream's strict read-only check. The observation sources already hide account-access mail and remove known secrets. The Inbox agent is a config file with no tools; it answers one structured decision per new thread through the ledger-tracked memory model. When the mail needs work, code opens the card itself: an `event` turn in a new session, a `tasks` row keyed by inbox and thread in `activity_key` (upstream's unique index makes it one card per thread), and an `agent_cards` row. Decisions are saved in a fork-only `inbox_triage` table.

## Upstream files touched

- `src/server/composition.ts`: creates the inbox triage with the observation sources, connected accounts and memory model, and runs it every 15 minutes while workers run and a model is connected.

## Considered options

Feeding mail through upstream's observer was rejected: observer turns are proactive, never run as an agent, start only with automatic preparation on, and share its $5 allowance. Giving the Inbox agent read tools and running it as a schedule was rejected because its `apps` tool could also send mail; with no tools, it can't send or reply by construction. Starting the card through `task start` was rejected because that path needs a running turn and lets only the Router start cards; the event source gives the card upstream's background authority, so the trust check asks the owner before any reply.
