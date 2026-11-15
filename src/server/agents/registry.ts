import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { parse } from 'yaml';
import type { RuntimeContext } from '../../ports/agent.ts';

const names = Type.Array(Type.String({ minLength: 1 }));

const agentSchema = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    role: Type.String({ minLength: 1 }),
    tools: names,
    model: Type.Optional(Type.String({ minLength: 1 })),
    skills: Type.Optional(names),
    cardSkills: Type.Optional(Type.Record(Type.String(), names)),
    connections: Type.Optional(names),
    budget: Type.Optional(
      Type.Object(
        { cardUsd: Type.Optional(Type.Number({ minimum: 0 })) },
        { additionalProperties: false },
      ),
    ),
    schedules: Type.Optional(names),
    knowledge: Type.Optional(names),
    workflows: Type.Optional(names),
  },
  { additionalProperties: false },
);

const teamSchema = Type.Object(
  {
    lead: Type.String({ minLength: 1 }),
    routing: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type AgentConfig = Static<typeof agentSchema> & {
  name: string;
  team: string;
  instructions: string;
};

export type TeamConfig = Static<typeof teamSchema> & { name: string; instructions: string };

export type AgentRegistry = {
  agents: Map<string, AgentConfig>;
  teams: Map<string, TeamConfig>;
  problems: Array<{ path: string; reason: string }>;
};

export const routerAgent = 'router';
const fallbackRouter = {
  name: routerAgent,
  title: 'Router',
  tools: ['task', 'ask_user', 'send_message'],
  instructions:
    'The Router config in agents/core/router.md is missing or invalid, so you run with routing tools only. Start a task for each request, tell the owner the Router config needs fixing, and never do the work yourself.',
};
const teamFile = 'team.md';

function document(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error('The file has no frontmatter block between --- lines.');
  return { fields: (parse(match[1]) ?? {}) as unknown, body: match[2].trim() };
}

function validated<T>(schema: Parameters<typeof Value.Check>[0], fields: unknown): T {
  if (Value.Check(schema, fields)) return fields as T;
  const error = Value.Errors(schema, fields).First();
  throw new Error(`${error?.path || 'frontmatter'}: ${error?.message ?? 'is invalid'}.`);
}

export async function loadAgentRegistry(
  root: string,
  knownTools?: readonly string[],
): Promise<AgentRegistry> {
  const registry: AgentRegistry = { agents: new Map(), teams: new Map(), problems: [] };
  const problem = (path: string, reason: string) =>
    registry.problems.push({ path: relative(root, path) || path, reason });
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    problem(root, `The agent config folder could not be read: ${(error as Error).message}`);
    return registry;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith('.md'))
      problem(path, 'Agent files belong in a team folder with a team.md file.');
    if (!entry.isDirectory()) continue;
    let files;
    try {
      files = (await readdir(path, { withFileTypes: true })).filter(
        (file) => file.isFile() && file.name.endsWith('.md'),
      );
    } catch (error) {
      problem(path, `The team folder could not be read: ${(error as Error).message}`);
      continue;
    }
    if (!files.some((file) => file.name === teamFile)) {
      problem(path, 'The team folder has no team.md file.');
      continue;
    }
    const members: AgentConfig[] = [];
    let team: TeamConfig | undefined;
    for (const file of files) {
      const filePath = join(path, file.name);
      try {
        const { fields, body } = document(await readFile(filePath, 'utf8'));
        if (file.name === teamFile)
          team = {
            ...validated<Static<typeof teamSchema>>(teamSchema, fields),
            name: entry.name,
            instructions: body,
          };
        else {
          const name = basename(file.name, '.md');
          if (registry.agents.has(name))
            throw new Error(`Another team already has an agent named ${name}.`);
          const config = validated<Static<typeof agentSchema>>(agentSchema, fields);
          const unknown = config.tools.filter(
            (tool) => knownTools && !tool.startsWith('mcp__') && !knownTools.includes(tool),
          );
          if (unknown.length) throw new Error(`tools: ${unknown.join(', ')} is not a Nod tool.`);
          members.push({
            ...config,
            name,
            team: entry.name,
            instructions: body,
          });
        }
      } catch (error) {
        problem(filePath, (error as Error).message);
      }
    }
    if (!team) continue;
    if (!members.some((member) => member.name === team.lead)) {
      problem(join(path, teamFile), `The lead ${team.lead} is not an agent in this team.`);
      continue;
    }
    registry.teams.set(team.name, team);
    for (const member of members) registry.agents.set(member.name, member);
  }
  return registry;
}

const cardRules =
  'You own this card until it closes. Close it with task finish {id, status, card: {conclusion, evidence: [...], nextAction, confidence: low|medium|high}}, or with question set to exactly one question for the owner when you need their decision. Any other finish is refused.';

export function cardOwners(registry: AgentRegistry) {
  return [...registry.agents.values()].filter((agent) => agent.name !== routerAgent);
}

function roster(registry: AgentRegistry) {
  const owners = cardOwners(registry);
  if (!owners.length)
    return 'No agent can own a card yet, so tell the owner the agent configs need adding.';
  const teams = [...registry.teams.values()]
    .map((team) => {
      const members = owners.filter((agent) => agent.team === team.name);
      return members.length
        ? `Team ${team.name} (lead ${team.lead}): ${team.routing}\n${members.map((agent) => `- ${agent.name}, ${agent.title}: ${agent.role}`).join('\n')}`
        : '';
    })
    .filter(Boolean);
  return `Start every card with agent set to the one agent that owns it, chosen from the team routing descriptions below, and estimateMinutes in agent minutes. Give work you can't place more precisely to the team's lead.\n${teams.join('\n')}`;
}

type BindingContext = Pick<RuntimeContext, 'threadId' | 'sessionId' | 'proactivity'>;

export function bindAgent(
  registry: AgentRegistry,
  context: BindingContext,
  cardAgent?: string,
): { agent?: NonNullable<RuntimeContext['agent']> } {
  if (context.proactivity) return {};
  if (context.sessionId === context.threadId) {
    const { name, title, tools, instructions } = registry.agents.get(routerAgent) ?? fallbackRouter;
    return {
      agent: { name, title, tools, instructions: `${instructions}\n\n${roster(registry)}` },
    };
  }
  if (!cardAgent) return {};
  const config = registry.agents.get(cardAgent);
  if (!config)
    return {
      agent: {
        name: cardAgent,
        title: cardAgent,
        tools: ['task', 'ask_user', 'send_message'],
        instructions: `The config for ${cardAgent} in agents/ is missing or invalid, so you can't do this card's work. Close the card with one question asking the owner to fix the config or reassign the card.\n${cardRules}`,
      },
    };
  return {
    agent: {
      name: config.name,
      title: config.title,
      tools: config.tools.includes('task') ? config.tools : [...config.tools, 'task'],
      instructions: `${config.instructions}\n\n${cardRules}`,
    },
  };
}

export function createAgentBinding(options: {
  knownTools: readonly string[];
  cardAgent: (sessionId: string) => Promise<string | undefined>;
  root?: string;
}) {
  const root = options.root ?? process.env.NOD_AGENTS_ROOT;
  if (!root) return { registry: async () => undefined, bind: async (_context: BindingContext) => ({}) };
  let reported = '';
  const load = async () => {
    const registry = await loadAgentRegistry(resolve(root), options.knownTools);
    const problems = JSON.stringify(registry.problems);
    if (problems !== reported) {
      reported = problems;
      for (const { path, reason } of registry.problems)
        console.error(JSON.stringify({ event: 'agent_config_rejected', path, reason }));
    }
    return registry;
  };
  void load();
  return {
    registry: load,
    bind: async (context: BindingContext) => {
      if (context.proactivity) return {};
      if (context.sessionId === context.threadId) return bindAgent(await load(), context);
      const cardAgent = await options.cardAgent(context.sessionId);
      return cardAgent ? bindAgent(await load(), context, cardAgent) : {};
    },
  };
}
