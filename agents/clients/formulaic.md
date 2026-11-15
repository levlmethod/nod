---
title: Formulaic
budget:
  monthlyUsd: 500
# Formulaic's GA4, Meta, Stripe, MongoDB, WordPress and support Gmail come through the Krowdit MCP server.
# Connect it in Nod with the service name krowdit, then add it here by the account name Apps shows for it:
#   - service: krowdit
#     account: <account name>
connections: []
dataSources: [ga4, stripe, meta, instagram, support-gmail, wordpress, mongodb]
thresholds:
  ga4-sessions-drop:
    agent: ga4-analyst
    source:
      service: krowdit
      tool: growth_ga4_run_report
      input: { metrics: [sessions], dimensions: [date], startDate: 8daysAgo, endDate: yesterday }
      values: 'rows[].metricValues.0.value'
      sortBy: 'rows[].dimensionValues.0.value'
    drop: 0.3
  ga4-key-events-drop:
    agent: ga4-analyst
    source:
      service: krowdit
      tool: growth_ga4_run_report
      input: { metrics: [keyEvents], dimensions: [date], startDate: 8daysAgo, endDate: yesterday }
      values: 'rows[].metricValues.0.value'
      sortBy: 'rows[].dimensionValues.0.value'
    drop: 0.4
  meta-spend-drop:
    agent: paid-media-analyst
    source:
      service: krowdit
      tool: growth_meta_query_insights
      input: { level: account, datePreset: last_14d, fields: [spend], timeIncrement: '1' }
      values: 'data[].spend'
    drop: 0.5
  failed-payments:
    agent: revenue-analyst
    source:
      service: krowdit
      tool: growth_stripe_list_charges
      input: { limit: 100 }
      values: 'data[status=failed].id'
      combine: count
    above: 10
inboxes:
  - address: support@theformulaic.info
    connection: krowdit
    tool: support_mail_gmail_search
    read: support_mail_gmail_read
    args:
      query: in:inbox newer_than:1d
      limit: 20
---

Formulaic is a client of Krowdit. Write its brand guide, goals and standing facts here. Only Formulaic's cards see this text.
