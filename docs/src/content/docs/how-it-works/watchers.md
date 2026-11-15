---
title: Watchers
description: How the marketing fork checks each client's metrics every hour in code, without a model, and opens one investigation card per anomaly for the right analyst.
sidebar:
  order: 10
---

Watchers check each client's numbers every hour. The check runs in code and calls no model, so an hour where nothing moves costs nothing. When a metric crosses its threshold, the watcher opens an investigation card for the agent the threshold names, with the numbers that tripped it. Clients and cards are described in [Clients and walls](/how-it-works/clients-and-walls/).

Watchers run only when agents are on (`NOD_AGENTS_ROOT` is set). The first check runs a minute after the server starts.

## Thresholds

Each threshold is an entry under `thresholds` in the client's file, keyed by a name of your choice. The name is the anomaly key, so a client has at most one open card per threshold.

```markdown
---
title: Formulaic
budget:
  monthlyUsd: 500
connections:
  - service: krowdit
    account: formulaic
thresholds:
  conversion-drop:
    agent: ga4-analyst
    source:
      service: krowdit
      tool: growth_ga4_run_report
      input: { metrics: [conversions], dimensions: [date], startDate: 8daysAgo }
      values: 'rows[].metricValues.0.value'
    drop: 0.3
  failed-payments:
    agent: revenue-analyst
    source:
      service: krowdit
      tool: growth_stripe_list_charges
      input: { limit: 100 }
      values: 'data[status=failed].id'
      combine: count
    above: 3
---
```

The tool names, inputs and paths above are examples. Check what the tool really returns, and its order, before writing `values`.

| Field             | Required | Meaning                                                                                                                                                  |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`           | Yes      | The agent that owns the investigation card. It must be an agent that can own a card.                                                                     |
| `source`          | Yes      | Where the numbers come from (below).                                                                                                                     |
| `drop`            | One of   | Trips when the latest value is this fraction or more below the average of the earlier values. `0.3` = 30%.                                               |
| `rise`            | One of   | Trips when the latest value is this fraction or more above that average, or above zero when it was zero.                                                 |
| `above`           | One of   | Trips when the latest value is above this number.                                                                                                        |
| `below`           | One of   | Trips when the latest value is below this number.                                                                                                        |
| `pace`            | One of   | `monthlyUsd` and `over`. The values are this month's daily spend; trips when their sum is more than `over` above the budget pro-rated to that many days. |
| `baseline`        | No       | How many earlier values make the average for `drop` and `rise`. Defaults to 7.                                                                           |
| `estimateMinutes` | No       | The card's estimate in agent minutes. Defaults to 30.                                                                                                    |

Each threshold has exactly one of `drop`, `rise`, `above`, `below` and `pace`. A client file with an invalid threshold is skipped and logged as `agent_config_rejected` with the threshold's name and the reason.

### Sources

`source` names one tool on one of the client's MCP connections:

- `service` is the MCP server's service or name, and the server's account must be one of the client's `connections`. A watcher never reads another client's connection.
- `tool` is the tool to call and `input` its arguments.
- `values` is a path to the numbers in the tool's result, oldest first. Steps are separated by dots; `name[]` takes every item of a list and `name[field=value]` only the items whose field equals that value. The result's structured content is used when the server returns it, otherwise its text parsed as JSON.
- `newestFirst: true` reverses a list that comes back newest first.
- `combine: count` checks how many items the path found, and `combine: sum` checks their total.

## Watchers only read

A watcher calls only a tool that reads. Before any call, a tool is refused when its server marks it as not read-only or destructive, or its name contains a write word such as create, send, update, delete or refund. Otherwise it runs when its server marks it read-only or its name contains a read word such as get, list, search, query or report. A refused tool is never called, and the watcher logs `watcher_check_failed` with the tool and the reason.

A failed read, a missing connection, an agent that can't own a card or a path that finds something other than numbers is logged the same way, with the threshold's key and the specific reason. The other thresholds still run.

## Investigation cards

An anomaly opens a card of type `investigation` for the threshold's client and agent, with the agent's card budget. The card's first turn carries the threshold name, the source and the numbers: the latest value, the baseline and the limit it crossed. The analyst works behind the client's wall, finds why the metric moved, and closes the card with the cause as its conclusion, the numbers as evidence, and the proposed fix and its tier as the next action.

The card starts like work Nod starts on its own: no owner message stands behind it, so every action it takes beyond a read goes through the trust check against the owner's notification rule and rules, and asks the owner otherwise.

While a card for an anomaly is open, the same anomaly opens no second card. Once the card closes or is stopped, the next hour that still trips opens a new one.
