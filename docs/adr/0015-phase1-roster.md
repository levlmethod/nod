# The Phase 1 roster reaches client tools by name, and browsers fill the gaps

The spec asks for a Growth team and a Creative team that can work on day one for RKMD, Formulaic and Krowdit. Most client data comes through one MCP server, the agency's Krowdit server, so the roster has to decide how agents get those tools and what they do where no tool exists.

Each agent lists the Krowdit tools it may use by their full Nod names (`mcp__krowdit__<tool>`), so the GA4 Analyst can't read Stripe and nobody gets a tool that sends, replies, refunds, archives or deletes. Upstream filters a session's tools by exact name, so this needs the server connected with the service name `krowdit`. The client wall still decides which client's cards see the server at all. Where a source has no tool on cards (Taboola, RKMD's GA4, Krowdit's Stripe), the analyst reads it in its own browser profile for that client.

Two small fork-code changes came with the client configs, because the real tools wouldn't work without them:

- Watcher sources take `sortBy`, because GA4's `run_report` returns day rows in no fixed order and has no sort input.
- Tool inboxes take `read`, because Gmail search through the Krowdit server lists only message and thread IDs. The inbox reads only threads it hasn't triaged yet, since each read is a model-checked call.

## Upstream files touched

None.

## Considered options

A wildcard such as `mcp__krowdit__*` in an agent's tools was rejected: it needs a change to upstream's tool filter, and it would hand every agent the server's send and refund tools.

The Krowdit server serves Formulaic's data under generic names (`growth_*`), so listing it on more than one client would let one client's cards read Formulaic's data. Only Formulaic lists it for now. Splitting the server per client is left to the owner.
