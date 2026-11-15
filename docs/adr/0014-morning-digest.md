# The morning digest is built in code and answers approvals through reply messages

At 7am America/New_York a pg-boss schedule runs the Chief of Staff's digest. Code collects it from the board read, the tier queue, PM escalations in `agent_card_activity`, `watcher_cards` and per-client spend, and posts it into the owner's active thread as assistant messages with no turn. When the owner has a Telegram conversation, each message also goes into upstream's `channel_outbox` against the latest Telegram inbox row, the way upstream's `/tasks` replies are delivered. `agent_digests` holds one row per owner and Eastern day, so a second fire posts nothing.

Each queued approval gets its own message whose `reply_to_message_id` is the approval's question. Upstream already resolves a reply to such a turnless assistant message to the approval it points at, in both Nod and chat apps, and then reads the reply with the trust checker as it does for any confirmation. So the digest needs no approval code of its own, and approving still runs only the bound, saved action.

## Upstream files touched

- `src/server/composition.ts`: creates the board earlier so the digest can read it, creates the digest, initialises its table and starts its schedule when agents are on.

## Considered options

A model-written digest was rejected: the ticket requires the digest to come from records, not agent chat, and a fixed daily report needs no model request. Releasing the held questions into the chat-app outbox at 7am was rejected because the questions alone don't carry the client, agent, why and cost of waiting, and they'd arrive scattered among other messages instead of under the digest.
