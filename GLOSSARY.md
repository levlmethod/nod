# Nod marketing fork

A multi-agent marketing system for an agency, built on Nod: named agents in teams do client work on cards, and the owner steps in only for decisions that matter.

## Language

### People and roles

**Owner**:
The person who runs the agency and this Nod installation. Only the owner's words authorize outside actions.
_Avoid_: User, admin, boss

**Agent**:
A named role defined by one config file, with its own instructions, tools, skills and budget.
_Avoid_: Bot, assistant, worker, subagent

**Team**:
A group of agents defined by a folder, with one lead and a routing description.
_Avoid_: Squad, department

**Lead**:
The agent that owns a team's outcomes and receives work the Router can't place more precisely.

**Router**:
The agent the main chat runs as. It only turns requests into cards; it never does the work.
_Avoid_: Orchestrator, coordinator, dispatcher

**PM**:
The agent that keeps cards on track. A code scan of the board flags stalls, loops and overruns every 30 minutes, and only flagged cards reach the PM, which nudges, splits, reassigns, decides or escalates.
_Avoid_: Project manager bot, supervisor

**Chief of Staff**:
The agent that writes the owner's morning digest.

**Watcher**:
The hourly check, in code with no model, of a client's thresholds against its data sources. It opens an investigation card for the threshold's agent when it finds an anomaly.
_Avoid_: Monitor, observer

**Inbox agent**:
The agent that reads new mail to the agency's inboxes, decides which client it is about and whether it needs work, and opens at most one card per email thread. It has no tools and never replies.
_Avoid_: Mail bot, email watcher

### Clients

**Client**:
An account the agency works for, such as RKMD, Formulaic or the agency itself. Every card belongs to one client.
_Avoid_: Customer, brand, account

**Wall**:
The rule that work for one client can see only that client's memory, connections and browser profiles.
_Avoid_: Sandbox, tenant

**Profile**:
A saved, signed-in browser profile that belongs to one agent and one client. Only that agent's cards for that client can open it.
_Avoid_: Browser session, cookie jar

### Work

**Card**:
One unit of work with exactly one owner agent, a done-when line, an estimate in agent minutes and a budget. It closes with a result or one question for the owner.
_Avoid_: Ticket, job, issue

**Result**:
How a card closes: a conclusion, its evidence, the next action and a confidence.
_Avoid_: Summary, output

**Child card**:
A card an agent starts from its own card to hand part of the work to another agent. The parent resumes once every child has closed.
_Avoid_: Subtask, subcard

**Blocker**:
A card another card waits on. A blocked card doesn't start until all its blockers close.
_Avoid_: Dependency, prerequisite

**Ask**:
One question an agent puts to another agent on a card, capped at three back-and-forths.
_Avoid_: Chat, discussion, thread

**Flag**:
A problem the board scan finds on an open card: stalled, a repeated question, an ask over its cap, a loop, over budget or left open. Each is flagged once until it gets worse.
_Avoid_: Alert, warning

**Card activity**:
The record on a card of each flag and each PM action, with its reason.
_Avoid_: Log, audit trail

**Agent minutes**:
The unit for every estimate and plan. Time waiting on the owner is counted separately.
_Avoid_: Days, hours of work

**Anomaly**:
A metric crossing a client's threshold, keyed so that it opens at most one card at a time.
_Avoid_: Alert, incident

**Brainstorm**:
A card type whose owner runs fixed rounds with 3 to 5 other agents: private ideas written in parallel, a cross-build, one devil's advocate, then the owner converges to a top three with reasons.

**Board**:
The page that shows every open and recently closed card by client and team, with blocked and waiting-on-owner cards marked.
_Avoid_: Dashboard, kanban

### Approvals

**Tier**:
How much freedom an action has. Tier 1 runs on its own; Tier 2 (raises spend, reaches a customer or client, or deletes) waits for the owner.
_Avoid_: Risk level, permission level

**Digest**:
The Chief of Staff's 7am Eastern report, which leads with the owner's queued Tier 2 decisions.
_Avoid_: Newsletter, summary, standup
