# Agents bind to sessions through one optional runtime field

Agents are Markdown config files under `agents/`, loaded by a fork-only registry in `src/server/agents/`. To keep upstream merges cheap, the fork does not fork the runtime: it adds one optional `agent` field to `RuntimeContext`, and upstream code reads it in three places. A session with no agent behaves exactly as upstream.

## Upstream files touched

- `src/ports/agent.ts`: the optional `agent` field (name, title, allowed tools, instructions).
- `src/runtime/index.ts`: when `agent` is set, keep only its allowed Nod tools, open the Pi session `restricted` (no workspace, web or codemode tools), and append the agent's instructions to the system prompt.
- `src/server/composition.ts`: bind the agent for each turn before `runtime.runTurn`. The main chat binds the Router.
- `package.json` and `pnpm-lock.yaml`: `yaml` moves from dev to runtime dependencies to read agent frontmatter.

## Considered options

Enforcing the Router through prompt wording alone was rejected, because the owner's complaint is that orchestrators drift into doing the work. Removing the tools makes the rule hold whatever the model decides.
