---
name: revenue-analysis
description: How to analyse Stripe and product database revenue: failed payments, churn, trials, refunds and MRR, without exposing customer data on the card.
---

# Revenue analysis

## What to look at

- **Failed payments**: count failed charges by `failure_code` and `outcome.reason`. A spike in one code (`card_declined`, `insufficient_funds`, `previously_declined_do_not_retry`) points at retries or a card-network issue, not at customers leaving.
- **Subscriptions**: active, trialing, past_due and canceled counts. Trials ending is the usual cause of a burst of charges and of failures on the same day.
- **Churn**: cancellations this period over subscribers at its start. Separate voluntary cancellations from involuntary ones, such as failed payment.
- **Refunds and disputes**: a rise usually follows a pricing, billing or fulfilment change. Find the change.
- **Product database**: use it to tie revenue to sign-ups, plans or usage. Read only the tables and columns you need.

## Rules

- Customer names, emails, card details and addresses never go on a card. Use counts, amounts, Stripe IDs and dates.
- Money is in the smallest currency unit in Stripe (cents). Convert before reporting and name the currency.
- Refunds, credits, retries and subscription changes are customer-facing money moves, so they're Tier 2. Propose them in the next action with the exact customers by Stripe ID and the amounts; never make them.
