# Taboola is a fork-only read-only connection for watchers

RKMD's spend is on Taboola, and the spec has the hourly watcher read it. Taboola has no MCP server, and its Backstage API signs in with a client ID and secret exchanged for a token that expires after hours. Upstream's discovered connections can't hold that: an HTTP access path sends one fixed bearer token, and a CLI path needs a published CLI to run.

The fork adds its own connection in `src/server/agents/taboola.ts`. The owner enters the client ID, secret and account ID in a form on the Board page; the server signs in and checks that the account is readable before saving. The account sits in a fork-only `taboola_connections` table, and the credentials go in upstream's app grant vault (`vault_app_grants`), encrypted with the vault key like any app token. The connection presents itself to the watcher as a `ConnectedMcpServer` with service `taboola` and the account ID as its account, so the client wall and the watcher's read-only guard apply unchanged.

Read-only is enforced twice: the connection has only three read tools and sends the API nothing but GETs (the token exchange is its only POST), and the watcher refuses any tool not named as a read. Errors keep Taboola's status and reason, with the secret and token removed.

## Upstream files touched

- `src/server/composition.ts`: creates and initializes the Taboola connection, registers its routes, and passes the watcher upstream's MCP servers and calls joined with Taboola's.

## Considered options

Asking the owner for a Taboola token as an upstream HTTP connection was rejected: the token expires, so the watcher would fail after a day. A Taboola MCP server run by n8n or the Krowdit MCP server was rejected for Phase 1, because neither has one and the watcher's tests would depend on a service outside the repo.

Giving card agents the Taboola tools through upstream's `apps` and trust check was left out. It needs hooks in upstream's integration and approval code; investigation cards start from the numbers that tripped instead.
