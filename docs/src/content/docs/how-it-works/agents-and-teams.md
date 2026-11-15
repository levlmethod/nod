---
title: Agents and teams
description: How the marketing fork defines agents and teams as config files, how the main chat runs as a Router that can only route work, how cards run as their owner agent, how cards split, block and ask each other, and how the PM keeps them on track.
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
│   ├── router.md
│   ├── pm.md
│   ├── inbox.md
│   └── chief-of-staff.md
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
| `skills`      | No       | Skills the agent must follow, loaded in full into every session it runs. See [Required skills](#required-skills).                          |
| `cardSkills`  | No       | Extra skills per card type, such as `investigation: [anomaly-triage]`, loaded with `skills` on cards of that type.                         |
| `connections` | No       | The app connections the agent may use. Not used yet; a card's connections come from its client.                                            |
| `budget`      | No       | `cardUsd`, the spend on one card. Saved on each card the agent owns; the PM flags a card that spends more.                                 |
| `schedules`   | No       | The agent's recurring schedules. Not used yet.                                                                                             |
| `knowledge`   | No       | Knowledge collections. Reserved for phase 2 and not used yet.                                                                              |
| `workflows`   | No       | n8n workflows. Reserved for phase 2 and not used yet.                                                                                      |

Nod reads the folder again at the start of every turn, so an edit takes effect on the next message. A file that can't be read, has no frontmatter, has an unknown or missing field, or sits outside a team folder is skipped. So is a team whose lead isn't one of its agents. Each skipped file is logged as `agent_config_rejected` with its path and reason, and every valid agent still loads.

## Required skills

An agent's `skills`, plus the `cardSkills` listed for the card's type, are added in full to the end of its system prompt before its first turn and on every turn after, so the agent doesn't have to choose to read them. The Router gets its own `skills` the same way. Nod looks for each name first in the fork's `agent-skills/` folder (`agent-skills/<name>/SKILL.md`, or the folder in `NOD_AGENT_SKILLS_ROOT`) and then in Nod's built-in skills. Each card turn adds a `Loaded skills:` line naming them to the card's activity.

A skill name that matches neither, or a skill file that can't be read, rejects the agent's file like any other config problem: it's logged as `agent_config_rejected` with the path and the missing name, and the agent's cards close with a question asking the owner to fix the config.

## The Router

The main chat runs as the `router` agent from the `core` team. Its session gets only the tools listed in `router.md`, and a call to any other tool is refused with a reason, and it opens without the workspace, web search or codemode tools, so it can't browse, read apps or run commands. It turns each request into a task for the agent that owns the work, answers status questions from the task ledger and asks the owner only when the client or goal is unclear. Its instructions are added to the end of the system prompt.

The Router sees every agent except itself, grouped by team with each team's `routing` description and each agent's `role`, and picks the one agent that owns the work. It must start each card with `agent` set to that agent's name, `client` set to the client the work is for and `estimateMinutes`, the agent minutes the work should take, and may set `cardType`. Clients and the wall around each card are described in [Clients and walls](/how-it-works/clients-and-walls/). A card started without them, or for the Router itself or an unknown agent, is refused with the reason and the list of agents.

If `router.md` is missing or invalid, the main chat still runs as a Router, with only `task`, `ask_user` and `send_message`, and tells the owner its config needs fixing. The problem is logged.

## Cards

A card is a task with one owner agent. Its details are kept in the `agent_cards` table, keyed by task ID: the owner agent, client, card type, estimate in agent minutes, the agent's `budget.cardUsd` and the result.

Every turn of the card's session runs as its owner agent, with that agent's tools and instructions and, like the Router, without the workspace, web search or codemode tools, so the owner's replies to a card reach the agent working it. If the agent's config is later removed or broken, the card's session keeps only `task`, `ask_user` and `send_message` and closes the card with a question asking the owner to fix it.

A card closes only through `task finish`, with one of:

- `card`: a `conclusion`, a non-empty `evidence` list, a `nextAction` and a `confidence` of `low`, `medium` or `high`.
- `question`: exactly one question for the owner, ending in its only question mark. Replying to it reopens the card.

Any other finish is refused with the missing parts named, and a final reply alone doesn't close a card. The card's saved result is the conclusion, evidence, next action and confidence as text, or the question. When `NOD_AGENTS_ROOT` isn't set, there are no cards: the chat starts plain tasks as upstream Nod does, and a task that names an agent is refused. Cards the Inbox agent opens from new mail run as their owner agent too; see [Inbox triage](/how-it-works/inbox-triage/). Schedules, other background work and other tasks Nod starts on its own don't run as an agent yet.

## Child cards, blockers and asks

Cards can depend on and talk to each other without anyone sharing work.

- **Child cards.** An agent working a card can split it with `task start` naming another `agent` and `estimateMinutes`. The child is its own card with its own session and owner agent, and records its parent. Once every child card has closed, the parent card's session is resumed with each child's title, owner, state and result.
- **Blockers.** A card started with `blockedBy`, a list of card IDs, waits until all of them settle: done with a conclusion, or stopped. A blocker that closes with a question for the owner still holds its dependents until the owner's reply reopens it and it closes with a conclusion. The blocked card's first turn is held in the queue until then, and when it starts its request includes each blocker's result. Only existing cards can block, so blockers can't form a loop. Child cards settle the same way before their parent is resumed.
- **Asks.** An agent can ask another agent a question about its card with `task ask {id, agent, question}`. The asked agent answers in its own session, with its own tools and instructions, through `task answer {id, answer}`, and can't start, change or close cards from there. The asking card is resumed with the answer. Each card allows one ask per agent and 3 back-and-forths on it; the 4th question is refused and the ask is flagged for the PM, which can make the call. If the asked agent's turn ends without answering, the next question to that agent records the earlier one as unanswered, counts it toward the 3 and flags the ask.

## Brainstorms

A brainstorm is a card with `cardType: brainstorm`. Its owner agent gets a `brainstorm` tool and runs fixed rounds with 3 to 5 other agents, so a brainstorm always ends:

1. **Private ideas.** Every participant writes ideas at the same time, each as an in-turn helper that sees only the card's title, brief and done-when line, so no idea anchors another.
2. **Cross-build.** Every participant sees all the private ideas and builds on the others'.
3. **Devil's advocate.** One participant, `devilsAdvocate` or else the last one named, argues against the built ideas.
4. **Converge.** The owner weighs the rounds and closes the card with `card.top`: exactly 3 `{idea, reason}`, best first, alongside the usual conclusion, evidence, next action and confidence. The saved result starts with the top 3.

Each participant runs with its own agent's instructions, tools and required skills, plus its `cardSkills` for `brainstorm`. The owner can't take part in its own brainstorm, and the Router can't either. The rounds run once per card: a second `brainstorm` call is refused, and the card can't close with a top 3 until they have run. A brainstorm can't run twice at once. One stopped part way can be started again from a later turn, because nothing is saved until the third round ends. Its participants and rounds are kept in the `agent_brainstorms` table. Only a brainstorm card closes with `top`, and the card can still close with one question for the owner instead.

## Agent time

Each card's agent time and waiting-on-owner time are worked out separately from its turns and turn events, against its estimate in agent minutes. Agent time is how long the card's turns, and the turns answering its asks, worked, up to the moment a turn stopped to wait for the owner. Waiting time runs from that moment, or from the moment the card closed with a question, until the next turn of the card starts, or until now while the owner hasn't answered. Time a card spends held by its blockers counts as neither.

## The PM

Every 30 minutes, while agents are on, code scans every open card without a model request. It flags a card when:

- its agent time passes twice its estimate, and again at four times, six times and so on;
- it asks the same question twice, to another agent or to the owner;
- one of its asks used its 3 back-and-forths or went unanswered;
- its last 12 tool calls include 4 calls to the same tool with the same input;
- the model spend of its turns and of the turns answering its asks passes its `budget.cardUsd`;
- it is still open 15 minutes after its last turn ended, with nothing queued, no open child cards, no ask being answered and no planned check, because a final reply alone doesn't close a card.

Each flag is recorded in the card's activity and isn't raised again until the problem gets worse or comes back, unless the PM turn it was sent to failed or was stopped before the PM acted on the card, in which case the next scan raises it again. When nothing new is flagged, nothing else happens. Otherwise one PM turn starts in its own background session, with the flagged cards, their flags and their asks. A new PM turn doesn't start while the last one is still queued or running.

The PM runs as the `pm` agent from `agents/core/pm.md`. Whatever its config lists, its only tool is `task`, and in its session only `task list` and these actions work, each only on a card its board check flagged:

| Action                                                                   | What it does                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `nudge {id, message}`                                                    | Resumes the card's owner agent with the PM's direction.                                                                         |
| `split {id, cards: [{agent, title, doneWhen, estimateMinutes}], reason}` | Resumes the owner agent with the child cards to start; the agent starts them, since a card starts from its own turn.            |
| `reassign {id, agent, reason}`                                           | Gives the card to another agent, which continues it on the card's next turn.                                                    |
| `decide {ask, decision}`                                                 | Makes the call on a stuck ask: the asked agent's unfinished answer is stopped and the asking card is resumed with the decision. |
| `escalate {id, question}`                                                | Posts the PM's question about the card in the main chat as a notice; the owner answers through the Router or the card.          |

A blocked card can't be nudged or split until its blockers close. Every action is saved in the card's activity, in the `agent_card_activity` table, with the PM's reason; `cards.read` returns it with the card. The PM can't own, ask on or do a card's work, and the Router never routes work to it. If `pm.md` is missing or invalid, the PM still runs with the same tool and rules.

The code is in `src/server/agents/`. Each upstream file it hooks into is recorded in an ADR in `docs/adr/`.
