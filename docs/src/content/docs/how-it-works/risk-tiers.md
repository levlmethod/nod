---
title: Risk tiers and the approval queue
description: How the marketing fork lets agents act alone on low-risk work, makes them wait for the owner on anything that raises spend, publishes, sends or deletes, and holds those waiting items in a queue instead of notifying overnight.
sidebar:
  order: 10
---

Agents working on cards act alone on low-risk work and wait for the owner on anything that matters. That split is the **tier**. Upstream's [trust check](/trust/approvals/) still decides every action; the fork only feeds it rules and adds one hard stop. Agents and cards are described in [Agents and teams](/how-it-works/agents-and-teams/), and clients in [Clients and walls](/how-it-works/clients-and-walls/).

## The two tiers

| Tier   | What it covers                                                                                                                                                  | What happens                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Tier 1 | Reads and research, drafts that aren't sent, new cards, and actions that only reduce spend, such as pausing an ad, ad set or campaign                           | Runs without asking                     |
| Tier 2 | Anything that raises spend or might (a budget or bid change, launching, resuming or turning on ads, paying), publishing or posting, sending to anyone, deleting | Waits for the owner's yes, in the queue |

A budget change is always Tier 2, even when it lowers the budget, because the action alone doesn't show which way the spend moves. To cut spend without asking, an agent pauses instead.

## How a tier reaches the trust check

Every turn of a card's session gets **tier rules** for its agent and client, written like owner rules and added to the owner's own [rules](/trust/approvals/#your-rules) for that check only. They name the agent, the client and the client's connected accounts. The go-ahead rule lets the checker run Tier 1 work on those accounts, and the ask-first rule makes it ask about Tier 2 work. Nothing is saved to the owner's rules, and work outside cards sees no tier rules.

On top of the rules, a **tier policy** in code reads the action's name and arguments. When it recognises Tier 2 work (for example a send, a reply, a publish, a delete, a refund, a budget or bid amount, or a status that turns ads on), the action asks the owner without a model check, so no model answer can run it. When the policy can't place an action, such as a browser step, the trust check decides it with the tier rules. The policy can only add a question; it never lets an action skip the check.

## The queue

Every approval a card raises is recorded in the queue with its client, agent, card, the exact action and its arguments, why the agent needs it, what happens if the owner waits, and whether it is urgent. The approval itself is upstream's: the owner approves or declines it on its card in Nod, bound to that exact action, and the card's agent continues from the answer.

Before a Tier 2 action, the agent sends its reasons with the card's task update:

```json
{
  "action": "update",
  "id": "<card id>",
  "approval": {
    "why": "The client asked for this week's numbers.",
    "ifWaiting": "They get them tomorrow morning instead of tonight.",
    "urgent": "Only when waiting would cause real harm, with the reason."
  }
}
```

The next approval on that card takes the note. Without one, the queue shows the card's title as the reason and says the agent didn't say what waiting costs. The approval question in Nod starts with the client, the agent, any urgent reason, why and what happens if the owner waits.

## Notifications

A queued item that isn't urgent doesn't notify: Nod web shows no browser notification for it and Telegram or WhatsApp never receive it. It waits for the morning digest, which leads with the queue. An item the agent marks urgent notifies at once, like any other question.

The code is in `src/server/agents/tiers.ts` (the tier policy and tier rules) and `src/server/agents/tier-queue.ts` (the queue, notes and hold). The upstream files it hooks into are listed in `docs/adr/0004-risk-tiers.md`.
