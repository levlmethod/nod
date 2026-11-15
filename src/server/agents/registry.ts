import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import type { ConnectedMcpServer, RuntimeContext } from '../../ports/agent.ts';
import { clientsFolder, loadClients, wallCard, type ClientConfig } from './clients.ts';
import { configFile } from './config-file.ts';

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
  clients: Map<string, ClientConfig>;
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

export async function loadAgentRegistry(
  root: string,
  knownTools?: readonly string[],
): Promise<AgentRegistry> {
  const registry: AgentRegistry = {
    agents: new Map(),
    teams: new Map(),
    clients: new Map(),
    problems: [],
  };
  const problem = (path: string, reason: string) =>
    registry.problems.push({ path: relative(root, path) || path, reason });
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    problem(root, `The agent config folder could not be read: ${(error as Error).message}`);
    return registry;
  }
  registry.clients = await loadClients(root, problem);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.name === clientsFolder) continue;
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
        const text = await readFile(filePath, 'utf8');
        if (file.name === teamFile) {
          const { fields, body } = configFile<Static<typeof teamSchema>>(teamSchema, text);
          team = { ...fields, name: entry.name, instructions: body };
        } else {
          const name = basename(file.name, '.md');
          if (registry.agents.has(name))
            throw new Error(`Another team already has an agent named ${name}.`);
          const { fields: config, body } = configFile<Static<typeof agentSchema>>(
            agentSchema,
            text,
          );
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
  const clients = [...registry.clients.values()]
    .map((client) => `- ${client.name}: ${client.title}`)
    .join('\n');
  return `Start every card with agent set to the one agent that owns it, chosen from the team routing descriptions below, client set to the one client the work is for, and estimateMinutes in agent minutes. Give work you can't place more precisely to the team's lead. Take the client from the owner's words; when they don't make it clear, ask the owner which client with ask_user before starting the card.\n${teams.join('\n')}\nClients:\n${clients || 'none yet, so tell the owner a client config needs adding under agents/clients/'}`;
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

type WallContext = BindingContext &
  Partial<
    Pick<
      RuntimeContext,
      'connectedApps' | 'mcpServers' | 'tasks' | 'relatedConversation' | 'learnedSkills'
    >
  > & {
    history?: RuntimeContext['history'];
  };

export function createAgentBinding(options: {
  knownTools: readonly string[];
  namespaces: (servers: ConnectedMcpServer[]) => string[];
  card: (sessionId: string) => Promise<{ agent: string; client: string | null } | undefined>;
  wallRecords: (
    sessionId: string,
    client: string | null,
  ) => Promise<{ sessionTurns: ReadonlySet<string>; clientCards: ReadonlySet<string> }>;
  root?: string;
}) {
  const root = options.root ?? process.env.NOD_AGENTS_ROOT;
  if (!root)
    return {
      registry: async () => undefined,
      bind: async (_context: BindingContext): Promise<ReturnType<typeof bindAgent>> => ({}),
    };
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
    bind: async (context: WallContext): Promise<Partial<RuntimeContext>> => {
      if (context.proactivity) return {};
      if (context.sessionId === context.threadId) return bindAgent(await load(), context);
      const card = await options.card(context.sessionId);
      if (!card) return {};
      const registry = await load();
      const { agent } = bindAgent(registry, context, card.agent);
      return wallCard(
        { ...context, history: context.history ?? [], agent: agent! },
        {
          client: card.client,
          clients: registry.clients,
          namespaces: options.namespaces,
          ...(await options.wallRecords(context.sessionId, card.client)),
        },
      );
    },
  };
}
