---
name: anomaly-triage
description: How to investigate a watcher's anomaly card: confirm the number, rule out tracking and data delays, find where the move is concentrated, then name the cause and a fix with its tier.
---

# Anomaly triage

A watcher opened this card because a metric crossed its threshold. The first turn holds the threshold, the source and the numbers that tripped it. Work through these steps in order and stop as soon as the cause is clear.

1. **Confirm it.** Re-read the same metric for the same window. If the latest day is partial, still processing, or the number has since corrected, say so and close with low urgency.
2. **Rule out measurement.** Check for a tracking break before blaming performance: a sudden zero, a metric that moved while its neighbours didn't (sessions flat but conversions to zero), a change on the site or in the tag setup, a time zone or attribution change.
3. **Find where it lives.** Break the metric down by the dimensions that matter for its source: campaign, ad set, ad, channel, landing page, device, country, plan or product. A move concentrated in one segment points at that segment's change.
4. **Line it up with changes.** Look for budget or bid edits, paused or newly approved ads, ended promotions, price changes, payment failures, outages and seasonality, such as a holiday or the day of week.
5. **Conclude.** The conclusion names the cause in one sentence. Evidence lists the numbers that show it. The next action proposes the fix and its tier: Tier 1 for reads, drafts and anything that only cuts spend, such as pausing an ad; Tier 2 for anything that raises or might raise spend, publishes, sends, deletes or archives, which waits for the owner.
6. If the move is real but you can't find a cause, say what you ruled out and set confidence to low. Don't invent a cause to close the card.
