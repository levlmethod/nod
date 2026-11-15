---
title: Set up the marketing agents
description: Run the levlmethod fork on a rented Linux server with the marketing agents on, then connect Krowdit, Taboola, Gmail, Telegram and each agent's browser sign-ins, and check it works.
sidebar:
  order: 9
---

This guide sets up the marketing fork (`levlmethod/nod`) on one server for the agency, with three clients: RKMD, Formulaic and Krowdit. The agents, teams and clients are described in [Agents and teams](/how-it-works/agents-and-teams/) and [Clients and walls](/how-it-works/clients-and-walls/). Allow about an hour. Most of it is signing in.

## 1. Rent the server

Rent a Linux **x86-64 (amd64)** server. On arm64 the browser falls back to Chromium, which many ad platforms flag, because Google ships no Linux arm64 Chrome.

| Item     | Choice                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------- |
| Size     | 4 vCPU, 16 GB memory, 100 GB disk. Several cards can browse at once, and each browser needs memory.   |
| System   | Ubuntu 24.04 LTS                                                                                      |
| Provider | Any from [Cloud providers](/deploy/providers/). Pick an amd64 plan, such as Hetzner CCX23 or similar. |
| Access   | SSH with a key. A domain is optional; without one, use an SSH tunnel.                                 |

Install Docker Engine 25 or newer with Compose v2, plus Git and OpenSSL, as in [Host your own server](/deploy/self-host/#what-you-need). Keep the cloud metadata caution on that page in mind.

## 2. Deploy from the fork

```sh title="Server"
git clone https://github.com/levlmethod/nod.git
cd nod/deployment/self-host
sh setup.sh
docker compose -f compose.yaml -f compose.agents.yaml up -d --build --wait
```

`compose.agents.yaml` turns the agents on. It sets `NOD_AGENTS_ROOT` and `NOD_AGENT_SKILLS_ROOT`, and mounts the checkout's `agents/` and `agent-skills/` folders read-only into the server. Edits to those files on the server apply on the next card, PM scan or watcher check, with no rebuild. Always pass both `-f` files when you run `docker compose` for this installation.

The first build compiles the server and builds the browser image with Google Chrome stable. To check which browser runs:

```sh title="Server"
docker compose -f compose.yaml -f compose.agents.yaml logs browser | grep browser_product
```

It should name Chrome. If it names Chromium, its `reason` says why.

To update later, run `git pull` in the checkout, then run the same `up -d --build --wait` command.

## 3. Sign in and connect a model

From your computer, open a tunnel and visit `http://localhost:4310`, or [add public HTTPS](/deploy/self-host/#add-public-https):

```sh title="Your computer"
ssh -L 4310:127.0.0.1:4310 <user>@<server-address>
```

Enter `NOD_AUTH_TOKEN` from the server's `.env`. Finish onboarding and connect a model.

## 4. Raise the spending limits

Each client file caps its cards at $500 a month. Nod's own monthly limit starts at $200 after onboarding, and once it's reached every card, watcher card and digest stops. In **Usage**, set the monthly limit to cover all three clients plus the Router and PM, such as $1,600.

Each session also checks in once its spend since your last message to it passes the task check-in ($5 by default). A card that checks in shows **Needs you** on the Board. Raise the check-in in **Usage** if that happens too often.

## 5. Connect Telegram for the digest

1. In Telegram, message **@BotFather**, send `/newbot` and copy the bot token.
2. Get your Telegram user ID, for example from **@userinfobot**.
3. Add both to the server's `.env`:

   ```sh title=".env"
   TELEGRAM_BOT_TOKEN=<bot token>
   TELEGRAM_ALLOWED_USER_ID=<your user ID>
   ```

4. Apply it with the same `docker compose -f compose.yaml -f compose.agents.yaml up -d --wait` command.
5. Send the bot any message. The [morning digest](/how-it-works/morning-digest/) goes to the latest Telegram conversation, so it reaches Telegram only after you have messaged the bot once.

More options are in [Configuration](/deploy/configuration/).

## 6. Connect the Krowdit MCP server

Formulaic's GA4, Stripe, Meta, Instagram, MongoDB, WordPress and support inbox all come through the agency's Krowdit MCP server.

1. Make the Krowdit MCP server reachable at a public HTTPS address. **Connect MCP** accepts only a public HTTPS URL, so a server running only on your own computer won't work. One option is to run it on this same server behind your own HTTPS proxy.
2. In Nod, open **Apps**, select **Connect MCP**, enter the name `krowdit` and the server's URL, and finish its sign-in. The name must be exactly `krowdit`, because the agents list its tools as `mcp__krowdit__…`.
3. Note the account name **Apps** shows for the connection.

## 7. Connect the Gmail inbox

In **Apps**, connect Gmail for **contact@crowdit.ai**. `agents/clients/krowdit.md` already lists it under `inboxes`, so the [Inbox agent](/how-it-works/inbox-triage/) starts reading it within 15 minutes of the connection. Formulaic's support inbox is read through the Krowdit server and needs no separate connection.

## 8. Connect Taboola

1. Ask your Taboola account manager for Backstage API access: a client ID and a client secret.
2. Note RKMD's advertiser `account_id`. This is the text ID, not the number.
3. In Nod, open **Board**. Under **Taboola**, enter the three values and select **Connect Taboola**. Nod checks that it can read the account before saving.

See [Watchers](/how-it-works/watchers/#taboola) for details.

## 9. Fill in the client files

On the server, edit the files in `nod/agents/clients/`.

- **`formulaic.md`**: replace `connections: []` with the Krowdit connection, using the account name from step 6.

  ```yaml
  connections:
    - service: krowdit
      account: <account name from Apps>
  ```

- **`rkmd.md`**: replace `connections: []` with the Taboola account from step 8.

  ```yaml
  connections:
    - service: taboola
      account: <account_id>
  ```

- **`krowdit.md`**: leave `connections: []` until Krowdit's Stripe has a tool.

Below each file's closing `---`, replace the placeholder with the client's brief. Include the brand guide and voice, goals and KPIs, offers, audiences, competitors, and anything an agent should never do for that client. Only that client's cards see it.

A file that fails to load is skipped, and the server logs `agent_config_rejected` with the reason:

```sh title="Server"
docker compose -f compose.yaml -f compose.agents.yaml logs server | grep agent_config_rejected
```

Commit the edited client files to a private branch, or back them up, so a `git pull` doesn't conflict with them. They hold client context, so keep them out of public repositories.

## 10. Sign in each agent's browser

Each agent keeps its own signed-in browser profile per client (see [Browser profiles](/how-it-works/clients-and-walls/#browser-profiles)). Saved logins from the Vault don't fill in for cards, so you type each sign-in once in Nod's private form, and the profile keeps it.

Ask in Nod's chat for one card per sign-in. For example:

> Open a card for the Paid Media Analyst for RKMD: connect a browser profile for Taboola Backstage, sign in, and save it.

| Agent              | Client  | Site                   |
| ------------------ | ------- | ---------------------- |
| Paid Media Analyst | RKMD    | Taboola Backstage      |
| GA4 Analyst        | RKMD    | Google Analytics (GA4) |
| Revenue Analyst    | Krowdit | Stripe Dashboard       |

When the card asks, enter the username, password and any code in the private form. Codes sent by email or app aren't filled automatically for cards, so type those too. Each card closes once its profile is saved.

## First test

Work through this list in order. Each line names what to check.

1. The **Board** shows RKMD, Formulaic and Krowdit, and no `agent_config_rejected` lines appear in the server log.
2. In chat, ask for a small piece of work, such as "What were Formulaic's sessions last week?". The Router opens a card for the GA4 Analyst and does not answer itself.
3. The card shows its estimate in agent minutes, runs, and closes with a conclusion and next action.
4. Ask for an RKMD GA4 check. The card opens the GA4 Analyst's RKMD profile without asking you to sign in again.
5. After an hour, the server log has no `watcher_check_failed` lines. A threshold that trips opens one investigation card on the Board.
6. Send a test email to contact@crowdit.ai that asks for work. Within 15 minutes, a card opens for the right client and agent.
7. Ask a card to draft something client-facing. The approval waits in the queue instead of interrupting you.
8. The next morning at 7am Eastern, the digest arrives in Nod and Telegram, with that approval first. Reply **yes** to its message.
9. **Usage** shows each client's spend under its $500 cap.

## Known gaps

- **Taboola is watcher-only.** The hourly watcher reads Taboola's API, but cards can't call it. A card that investigates RKMD's Taboola reads Backstage in the Paid Media Analyst's browser profile.
- **Some sources have no watcher.** No tools exist for RKMD's GA4 or Krowdit's Stripe, so no watcher checks them. Agents read them in their browser profiles when a card asks.
- **Drops to zero are missed.** A threshold compares values the tool returns. A day with no rows, such as spend stopping completely, gives no value to compare, so it doesn't trip a drop.
- **Instagram and WordPress** have no thresholds yet. Their tools are available to cards through Krowdit.
- **One owner.** The server belongs to one person and has no team accounts.
