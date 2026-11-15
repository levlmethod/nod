---
title: Morning digest
description: How the marketing fork's Chief of Staff posts a 7am Eastern digest to Nod and Telegram that leads with the owner's queued decisions, then reports escalations, finished and stuck cards, anomalies and spend per client.
sidebar:
  order: 10
---

Every morning at 7am Eastern the **Chief of Staff** posts a digest to the owner's chat in Nod and to Telegram. It leads with the decisions only the owner can make, then reports what happened since the last digest. Cards, agents and clients are described in [Agents and teams](/how-it-works/agents-and-teams/) and [Clients and walls](/how-it-works/clients-and-walls/), and the queue in [Risk tiers and the approval queue](/how-it-works/risk-tiers/).

## Built from records, not chat

The digest is assembled in code, with no model request, from the same records the [Board](/how-it-works/board/) reads, the approval queue and the usage ledger. Nothing an agent writes in chat can change what it reports. It runs only when agents are on and `agents/core/chief-of-staff.md` is a valid agent config; the Chief of Staff never owns a card.

## What it posts

The digest is a short run of messages in this order:

1. An opening line that says how many decisions are waiting.
2. One message per queued Tier 2 approval, urgent ones first. Each names the client and agent, repeats the approval question exactly as Nod wrote it, names the card, and says why the agent needs it and what happens if the owner waits.
3. A report with these sections, each left out when empty:
   - **Escalated by the PM**: questions the PM sent the owner since the last digest.
   - **Finished**: cards that closed with a conclusion since the last digest, with their conclusion and next action.
   - **Blocked or waiting on you**: open cards that are blocked by other cards, whose last run failed, or that wait on the owner, other than cards already in the decisions or escalations.
   - **Anomalies found**: anomalies the [watchers](/how-it-works/watchers/) opened since the last digest, and whether their investigation is still open.
   - **Spend this month**: each client's model spend against its monthly cap, and the reason when its cards are paused at the cap.

"Since the last digest" means since the previous digest was posted, or the last 24 hours for the first one. One digest is posted per Eastern calendar day, even if the schedule fires twice. A run that fails is retried up to three times, five minutes apart.

## Approving and declining from the digest

Each decision message is a reply to the approval it describes. To answer, the owner replies **yes** or **no** to that message, in Nod or in Telegram. Nod reads the reply against that exact approval, the same way it reads a reply to the original question, so a yes runs only the saved action and anything other than a clear yes doesn't run it. Only a reply answers a decision: a plain yes sent without reply doesn't reach a digest decision. The approval card on the card's own page in Nod still works too. The digest lists only approvals that can still be answered in the current conversation.

Telegram gets the digest when the owner has messaged Nod from Telegram before, because Nod replies in the most recent Telegram conversation. Without one, the digest is in Nod only.

The code is in `src/server/agents/digest.ts`. The upstream file it hooks into is listed in `docs/adr/0013-morning-digest.md`.
