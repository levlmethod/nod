---
title: Clients and walls
description: How the marketing fork defines each client as a config file, ties every card to one client, keeps a card's view to that client's brief, connections and cards, and pauses a client's work at its monthly model budget.
sidebar:
  order: 9
---

The agency works for several clients, and one client's data must never show up in another client's work. Each client is one config file, every card belongs to exactly one client, and a card sees only that client. That rule is the wall. Agents and cards are described in [Agents and teams](/how-it-works/agents-and-teams/).

## Client files

Clients live in `agents/clients/`, one Markdown file per client, named after the client:

```text
agents/
└── clients/
    ├── rkmd.md
    ├── formulaic.md
    └── krowdit.md
```

The frontmatter defines the client and the body is its brief: brand guide, goals and standing facts. Only that client's cards see the brief.

```markdown
---
title: RKMD
budget:
  monthlyUsd: 500
connections:
  - service: googleanalytics
    account: analytics@rkmd.example
dataSources: [taboola, ga4]
inboxes: []
---

RKMD's brand guide and goals.
```

| Field         | Required | Meaning                                                                                                                                                |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`       | Yes      | The client's display name.                                                                                                                             |
| `budget`      | Yes      | `monthlyUsd`, the most the client's cards may spend on models in a calendar month.                                                                     |
| `connections` | No       | The connected accounts the client's cards may use. Each entry names the app or MCP server by `service` and the signed-in `account`, as listed in Apps. |
| `dataSources` | No       | The sources the client's watchers check. Not used yet.                                                                                                 |
| `thresholds`  | No       | Alert thresholds per metric for the watchers. Not used yet.                                                                                            |
| `inboxes`     | No       | Email inboxes whose mail belongs to the client. Not used yet.                                                                                          |

A file with no frontmatter, an unknown or missing field, or a budget that isn't above zero is skipped and logged as `agent_config_rejected` with its path and reason. The `clients` folder is not a team, so it needs no `team.md`.

## Every card has one client

The Router must start each card with `client` set to one of the client file names, taken from the owner's words. When the owner's words don't make the client clear, the Router asks which client before starting the card. A card started without a client, or with a name that has no client file, is refused with the reason and the list of clients. The client is saved on the card's `agent_cards` row.

## The wall

Every turn of a card's session runs behind its client's wall:

- **Brief.** The agent's instructions gain the client's title and brief. No other client's brief is shown.
- **Connections.** Only the apps and MCP servers listed in the client's `connections` are offered. An `apps` call must name the `connectionId` of one of them; a call naming another client's connection is refused with the client it belongs to, and a call with no connection or an unlisted one is refused with the client's own connections.
- **Memory and chat.** The owner's saved memory, related conversation and history search are shared across every client, so a card gets none of them: no memory index, no memory preparation, no related messages, and `manage_personal_context` is refused with the reason. The card's recent conversation holds only its own session's messages, not the main chat or other cards.
- **Learned procedures.** Learned skills are shared across clients, so a card isn't shown them and can't read, save or patch one. Task guides still work.
- **Cards.** The task ledger in the card's context lists only cards for the same client, and `task list` is refused.
- **Owner-wide tools.** `manage_apps`, `pay` and `files` reach the owner's accounts, cards and computer across every client, so a card can't use them.
- **Browser profiles.** A card opens only the saved browser profiles its own agent made for its own client, as described below.

A card whose client file is missing or invalid can use no connections and is told to close with one question asking the owner to fix the client file.

## Browser profiles

Each agent keeps its own signed-in browser profiles for each client, so the Ads Buyer stays signed in to RKMD's ad accounts and a different profile holds Formulaic's. A profile is one of Nod's saved browser sessions, kept in the browser container under its own profile folder.

- **Making one.** `browser_session connect` from a card makes a profile owned by the card's agent and client and labels it `<client> · <agent>: <site>`, so the Vault shows whose it is. The card signs in with `sign_in` and keeps it with `browser_session save`.
- **Using one.** A card's context lists its own agent's saved profiles for its client. `browser_session use` opens one of those; any other profile, including the owner's own and another agent's or client's, is refused with the agent and client it belongs to.
- **Signing in.** A card can use `sign_in` only while its browser has one of its own profiles open, so the session stays in that profile. Saved logins and email codes come from the owner's Vault and mailbox, which hold every client's accounts, so a card can't use `savedLoginId` or `emailCode`, and Nod doesn't fill a saved login or authenticator code for it. The owner enters the sign-in privately once, and the profile keeps it. Every sign-in and saved-session use still goes through the trust check.
- **Owner access.** The main chat and plain tasks aren't behind a wall and can open any profile. The owner removes a profile from the Vault as usual.

Card agents still run without the workspace or Pi's web search. An agent with `browser` reaches public pages through the browser, which is enough for signed-in dashboards and site research, so browser agents get no separate web tool.

The code is in `src/server/agents/browser-profiles.ts`. The upstream files it hooks into are listed in `docs/adr/0004-agent-browser-profiles.md`.

The main chat, where the Router runs, is not behind a wall: it sees the owner's memory and every client, because it only routes work.

## Monthly client budget

Each client's spend for the month is the sum of `model_usage` costs for the sessions of its cards, counted from the start of the month in the owner's time zone. Plan usage that has no API price is not counted, matching the owner's monthly limit.

When a client's spend reaches its `budget.monthlyUsd`, each new turn of its cards fails before the model with the reason: what the client has spent, its budget and how to raise it. The pause is saved in the `client_budget_pauses` table, one row per client and month with the latest spend, budget, reason and turn, for the morning digest to show. Other clients keep running. A reply the owner sends on a card still runs, so the owner can decide what happens next; raising `budget.monthlyUsd` takes effect on the next turn.

The code is in `src/server/agents/clients.ts` and `src/server/agents/client-budget.ts`. The upstream files it hooks into are listed in `docs/adr/0003-client-walls.md`.
