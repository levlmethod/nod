# Agents bind to sessions through one optional runtime field

Agents are Markdown config files under `agents/`, loaded by a fork-only registry in `src/server/agents/`. To keep upstream merges cheap, the fork does not fork the runtime: it adds one optional `agent` field to `RuntimeContext`, and upstream code reads it at a few small hooks. A session with no agent behaves exactly as upstream.

## Upstream files touched

- `src/ports/agent.ts`: the optional `agent` field (name, title, allowed tools, instructions).
- `src/runtime/index.ts`: when `agent` is set, keep only its allowed Nod tools, refuse any other tool call with a reason, open the Pi session `restricted` (no workspace, web or codemode tools), and append the agent's instructions to the full and compact system prompts.
- `src/server/composition.ts`: bind the agent for each turn before `runtime.runTurn`, checking config tool names against `toolDefinitions`. The main chat binds the Router, or a routing-only fallback when its config is broken, so the rule never fails open.
- `package.json` and `pnpm-lock.yaml`: `yaml` moves from dev to runtime dependencies to read agent frontmatter.

## Considered options

Enforcing the Router through prompt wording alone was rejected, because the owner's complaint is that orchestrators drift into doing the work. Removing the tools makes the rule hold whatever the model decides.
