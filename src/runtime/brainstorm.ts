import { Type } from '@sinclair/typebox';
import type {
  BrainstormParticipant as Participant,
  BrainstormPlan,
  BrainstormRound,
} from '../ports/brainstorm.ts';

export const brainstormDescription =
  "Run this brainstorm card's fixed rounds with 3 to 5 other agents: private ideas written in parallel, a cross-build, then one devil's advocate. Call it once; the rounds can't be rerun. You then converge to a top 3 yourself and close the card.";

export const brainstormParams = Type.Object(
  {
    participants: Type.Array(Type.String({ minLength: 1 }), { minItems: 3, maxItems: 5 }),
    devilsAdvocate: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const listed = (round: BrainstormRound, plan: BrainstormPlan) =>
  round.entries
    .map(
      (entry) =>
        `### ${plan.participants.find((agent) => agent.name === entry.agent)?.title ?? entry.agent}\n${entry.text}`,
    )
    .join('\n\n');

export async function runBrainstorm(
  plan: BrainstormPlan,
  help: (participant: Participant, title: string, instruction: string) => Promise<string>,
): Promise<BrainstormRound[]> {
  const topic = `Brainstorm topic: ${plan.topic}`;
  const all = (round: BrainstormRound['round'], title: string, instruction: string) =>
    Promise.all(
      plan.participants.map(async (agent) => ({
        agent: agent.name,
        text: await help(agent, `${title}: ${agent.title}`, instruction),
      })),
    ).then((entries) => ({ round, entries }));
  const ideas = await all(
    'ideas',
    'Brainstorm round 1 of 4: private ideas',
    `${topic}\n\nRound 1 of 4: private ideas. Write 3 to 5 ideas from your own role, each with one line on why it would work. You can't see anyone else's ideas, so don't guess at them.`,
  );
  const build = await all(
    'build',
    'Brainstorm round 2 of 4: cross-build',
    `${topic}\n\nRound 2 of 4: cross-build. Here are everyone's private ideas:\n\n${listed(ideas, plan)}\n\nBuild on the other agents' ideas: combine, sharpen or extend them, naming whose idea each one builds on. Give your 3 strongest built ideas.`,
  );
  const devil = plan.participants.find((agent) => agent.name === plan.devilsAdvocate)!;
  const critique = {
    round: 'devil' as const,
    entries: [
      {
        agent: devil.name,
        text: await help(
          devil,
          `Brainstorm round 3 of 4: devil's advocate: ${devil.title}`,
          `${topic}\n\nRound 3 of 4: devil's advocate. Here are the built ideas:\n\n${listed(build, plan)}\n\nArgue against the strongest of them: the risks, costs and reasons each could fail. Don't add new ideas.`,
        ),
      },
    ],
  };
  return [ideas, build, critique];
}

export function brainstormOutcome(plan: BrainstormPlan, rounds: BrainstormRound[]) {
  const [ideas, build, devil] = rounds;
  return {
    rounds: rounds.map((round) => round.round),
    transcript: `## Round 1: private ideas\n\n${listed(ideas!, plan)}\n\n## Round 2: cross-build\n\n${listed(build!, plan)}\n\n## Round 3: devil's advocate\n\n${listed(devil!, plan)}`,
    next: "Round 4 of 4 is yours: converge. Weigh the ideas against the devil's advocate and close this card with task finish {id, status: 'done', card: {conclusion, evidence, nextAction, confidence, top: [{idea, reason}, {idea, reason}, {idea, reason}]}}: exactly 3 ideas, best first, each with its reason. The rounds don't run again.",
  };
}
