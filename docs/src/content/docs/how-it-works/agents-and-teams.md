---
title: Agents and teams
description: How the marketing fork defines agents and teams as config files, and how the main chat runs as a Router that can only route work.
sidebar:
  order: 8
---

In this fork, work is done by named agents organised into teams. Each agent is one Markdown file, and each team is one folder. Adding an agent means adding a file; no code changes are needed. The terms are defined in the repository's `GLOSSARY.md`.

## The config folder

Agents live in the `agents/` folder at the root of the repository. Set `NOD_AGENTS_ROOT` to the folder to turn agents on; `.env.example` sets it to `agents`. Without it, Nod runs as upstream Nod does and no session runs as an agent.

```text
agents/
├── core/
│   ├── team.md
│   └── router.md
└── growth/
    ├── team.md
    ├── growth-lead.md
    └── paid-media-analyst.md
```

Every team folder has a `team.md` file. Its frontmatter names the team's `lead`, which must be an agent in the same folder, and a `routing` description that says what work the team takes:

```markdown
---
lead: growth-lead
routing: Paid media, analytics and revenue work for every client.
---
```

Every other `.md` file in the folder is an agent, named after its file. The frontmatter defines the agent and the body is its instructions:

```markdown
---
title: Growth Lead
role: Owns growth outcomes for each client.
tools: [task, ask_user, browser, apps]
skills: [research]
---

Lead the growth team. Split work into cards for the right analyst.
```

| Field         | Required | Meaning                                                                                                                                    |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`       | Yes      | The agent's display name.                                                                                                                  |
| `role`        | Yes      | One line on what the agent is for.                                                                                                         |
| `tools`       | Yes      | The Nod tools the agent may use, by name. Every other tool is removed from its session, and a name that isn't a Nod tool rejects the file. |
| `model`       | No       | The model the agent should use. Not used yet.                                                                                              |
| `skills`      | No       | Skills the agent must follow. Not used yet.                                                                                                |
| `cardSkills`  | No       | Extra skills per card type. Not used yet.                                                                                                  |
| `connections` | No       | The app connections the agent may use. Not used yet.                                                                                       |
| `budget`      | No       | `cardUsd`, the spend on one card before it checks in. Not used yet.                                                                        |
| `schedules`   | No       | The agent's recurring schedules. Not used yet.                                                                                             |
| `knowledge`   | No       | Knowledge collections. Reserved for phase 2 and not used yet.                                                                              |
| `workflows`   | No       | n8n workflows. Reserved for phase 2 and not used yet.                                                                                      |

Nod reads the folder again at the start of every turn, so an edit takes effect on the next message. A file that can't be read, has no frontmatter, has an unknown or missing field, or sits outside a team folder is skipped. So is a team whose lead isn't one of its agents. Each skipped file is logged as `agent_config_rejected` with its path and reason, and every valid agent still loads.

## The Router

The main chat runs as the `router` agent from the `core` team. Its session gets only the tools listed in `router.md`, and a call to any other tool is refused with a reason, and it opens without the workspace, web search or codemode tools, so it can't browse, read apps or run commands. It turns each request into a task for the agent that owns the work, answers status questions from the task ledger and asks the owner only when the client or goal is unclear. Its instructions are added to the end of the system prompt.

If `router.md` is missing or invalid, the main chat still runs as a Router, with only `task`, `ask_user` and `send_message`, and tells the owner its config needs fixing. The problem is logged. Task sessions, schedules and background work don't run as an agent yet.

The code is in `src/server/agents/`. The upstream files it hooks into are listed in `docs/adr/0001-agents-hook-into-upstream-runtime.md`.
