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
The agent that keeps cards on track: it flags stalls, loops and overruns and decides or escalates.
_Avoid_: Project manager bot, supervisor

**Chief of Staff**:
The agent that writes the owner's morning digest.

**Watcher**:
An agent that checks a client's data sources on a schedule and opens a card when it finds an anomaly.
_Avoid_: Monitor, observer

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

**Ask**:
One question an agent puts to another agent on a card, capped at three back-and-forths.
_Avoid_: Chat, discussion, thread

**Agent minutes**:
The unit for every estimate and plan. Time waiting on the owner is counted separately.
_Avoid_: Days, hours of work

**Anomaly**:
A metric crossing a client's threshold, keyed so that it opens at most one card at a time.
_Avoid_: Alert, incident

**Brainstorm**:
A card type with fixed rounds: private ideas, cross-build, devil's advocate, then a top three.

### Approvals

**Tier**:
How much freedom an action has. Tier 1 runs on its own; Tier 2 (raises spend, reaches a customer or client, or deletes) waits for the owner.
_Avoid_: Risk level, permission level

**Digest**:
The Chief of Staff's 7am Eastern report, which leads with the owner's queued Tier 2 decisions.
_Avoid_: Newsletter, summary, standup
