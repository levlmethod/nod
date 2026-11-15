---
title: RKMD
budget:
  monthlyUsd: 500
# Connect RKMD's Taboola advertiser account on the Board page, then add it here by its account_id:
#   - service: taboola
#     account: <account_id>
# RKMD's GA4 has no tools yet, so the GA4 Analyst reads it in its RKMD browser profile.
connections: []
dataSources: [taboola, ga4]
thresholds:
  taboola-spend-drop:
    agent: paid-media-analyst
    source:
      service: taboola
      tool: get_campaign_summary
      input: { days: 8, timeZone: America/New_York }
      values: 'results[].spent'
    drop: 0.5
  taboola-cpa-rise:
    agent: paid-media-analyst
    source:
      service: taboola
      tool: get_campaign_summary
      input: { days: 8, timeZone: America/New_York }
      values: 'results[].cpa'
    rise: 0.5
inboxes: []
---

RKMD is a client of Krowdit. Write its brand guide, goals and standing facts here. Only RKMD's cards see this text.
