# Required skills load into the agent's instructions

An agent's required skills, and the skills its config maps to the card's type, are read by the fork's agent binding (`src/server/agents/skills.ts`) and appended in full to the agent's instructions, which ADR 0001 already adds to the full and compact system prompts. No runtime file changes: upstream's skill catalog and on-demand `skills` read stay as they are for every other session.

Fork skills live in `agent-skills/<name>/SKILL.md`, outside `agents/`, so the registry keeps treating every folder under `agents/` as a team. A name not found there falls back to Nod's built-in skill library. A missing skill rejects the agent at load, like an unknown tool, so a card never runs without a skill its config requires.

## Upstream files touched

- `src/server/composition.ts`: passes Nod's built-in skill library and the card's type lookup to the agent binding. The binding writes a `Loaded skills:` step to the card turn's activity.

## Considered options

Telling the agent to read its skills with the `skills` tool was rejected, because the owner's complaint is that agents ignore the skills they're given. Putting them in the system prompt makes them present whatever the model decides, and keeps them after compaction.
