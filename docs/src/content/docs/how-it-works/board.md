---
title: Board
description: How the marketing fork's Board page shows every card by client and team, with its owner, state, blockers, agent time against its estimate, time waiting on the owner and spend.
sidebar:
  order: 10
---

The Board page in Nod web shows the agency's work at a glance. It lists every open card, every card closed in the last 7 days and every card whose question to the owner is still unanswered, grouped by client and then by team. Cards and clients are described in [Agents and teams](/how-it-works/agents-and-teams/) and [Clients and walls](/how-it-works/clients-and-walls/).

![The Board page with a synthetic client's Growth and Creative cards. A card waiting on the owner is pink, a blocked card is amber and names the card it waits on, and an opened card shows its done-when line, child cards, an ask flagged for the PM, a PM nudge and its activity.](../../../assets/screens/board.png)

## What each card shows

- **Owner agent**, the one agent that owns the card.
- **State**: working, queued, waiting, failed, done or stopped, as on the Scheduled page, plus two states that stand out. **Blocked** cards are amber and name the open cards they wait on. **Waiting on you** cards are pink: the card asked the owner a question, or closed with one question for the owner. Waiting on you shows even when the card also has an open blocker.
- **Agent time against the estimate**, in agent minutes. Time over the estimate is shown in red.
- **Waited on you**, the time the card spent waiting on the owner, kept apart from agent time.
- **Spend**, the model spend of the card and of the asks on it, against the agent's `budget.cardUsd`.
- **Ask flagged** when one of its asks used up its 3 back-and-forths or went unanswered.

Cards that need the owner or are blocked come first in each team. Each client's heading shows its model spend this month against `budget.monthlyUsd`, and the reason when its cards are paused at the cap.

## Opening a card

Selecting a card opens its done-when line, its result or its question for the owner, its child cards, each ask with its questions and answers, the actions the PM took on it and the card's activity.

## Taboola

Below the clients, the **Taboola** section lists the connected Taboola accounts and has the form that adds one. See [Watchers](/how-it-works/watchers/#taboola).

## Access

The page reads `GET /api/board` and `GET /api/board/cards/:id`. Like every `/api` route they need the local access key and return only the owner's own cards. When `NOD_AGENTS_ROOT` isn't set, the page says that agents are off.

The code is in `src/server/agents/board.ts` and `src/web/pages/board.tsx`. The upstream files it hooks into are listed in `docs/adr/0005-board-page.md`.
