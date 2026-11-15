# Brainstorms run their rounds as in-turn helpers bound to other agents

A brainstorm card's owner calls one `brainstorm` tool, and the runtime runs the fixed rounds itself with upstream's `delegate` helpers: every participant in parallel for private ideas and again for the cross-build, then one devil's advocate. Code, not the model, decides the number and order of rounds, so a brainstorm always ends, and the private round can't anchor because each helper starts from the topic alone. The owner converges in its own turn by closing the card with a top 3, which the card service checks. Each helper runs with the participant's own instructions, tools and required skills, resolved by the agent binding, instead of the owner's.

The card service keeps each brainstorm in `agent_brainstorms`, refuses a second run once the rounds are saved, checks that the saved rounds are exactly ideas and cross-build from every participant and one devil's advocate, and refuses a top 3 before that.

## Upstream files touched

- `src/runtime/index.ts`: `delegate` takes an optional agent, whose prompt section and tool list replace the owner's for that helper, and the tool guard checks the agent the tool runs as. When the turn's context has brainstorm hooks, the turn gets a `brainstorm` tool that runs the rounds from `src/runtime/brainstorm.ts`.
- `src/runtime/turn.ts`: `delegate` gains the optional agent and the turn gains `brainstorm`.
- `src/runtime/tools.ts`: the `brainstorm` tool definition and its binding. The card finish schema gains `top` through the existing spread of `src/shared/cards.ts`.
- `src/ports/agent.ts`: `RuntimeContext.brainstorm`, typed in the fork's `src/ports/brainstorm.ts`.
- `src/server/composition.ts`: the card service resolves participants through the agent binding, and a turn whose agent has the `brainstorm` tool gets the card service's brainstorm hooks.

## Considered options

Letting the owner run the rounds by calling `delegate` itself was rejected: the model could skip, repeat or merge rounds, and its helpers would run with the owner's prompt and tools. Running participants as child cards or asks was rejected: they run in separate sessions one after another, can see each other's results and would turn a brainstorm into many cards on the board.
