import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import type { ConnectedMcpServer, RuntimeContext } from '../../ports/agent.ts';
import { clientsFolder, loadClients, wallCard, type ClientConfig } from './clients.ts';
import { configFile } from './config-file.ts';
import type { BrainstormParticipant } from '../../ports/brainstorm.ts';
import { brainstormCard, brainstormTop } from '../../shared/cards.ts';
import {
  loadAgentSkills,
  rejectMissingSkills,
  requiredSkills,
  skillInstructions,
  type AgentSkillSources,
} from './skills.ts';

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
export const pmAgent = 'pm';
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
  'You own this card until it closes. Close it with task finish {id, status, card: {conclusion, evidence: [...], nextAction, confidence: low|medium|high}}, or with question set to exactly one question for the owner when you need their decision. Any other finish is refused.\nTo split the work, start child cards with task start {..., agent, estimateMinutes, blockedBy?: [card IDs]}; a card with blockedBy waits until those cards close, and you are resumed with the results once every child card closes. To get one fact from another agent without handing over the work, use task ask {id: your card ID, agent, question}; you are resumed with the answer, and each agent allows 3 back-and-forths per card.';

const askRules =
  "Another agent asked you a question on their card. The card stays theirs: answer only what was asked, using your tools if you need to check something, and reply with task answer {id, answer}. Don't start, change or close cards from here.";

const brainstormRules = `This is a brainstorm card. Its rounds are fixed: call brainstorm {participants: 3 to 5 other agents, devilsAdvocate?} once to run private ideas, a cross-build and one devil's advocate, then converge yourself to a top 3 and close the card with card.top set to exactly ${brainstormTop} {idea, reason}, best first.`;

const participantRules =
  "You're taking part in a brainstorm on another agent's card. Answer only the round you're given, from your own role, and keep to what the round asks. You can't start, change or close cards.";

const pmRules = (owners: string) =>
  `You are the PM. You keep cards on track and never do a card's work: your only tool is task, and only these actions work:\n- task list: read the board.\n- task nudge {id, message}: resume the card's owner agent with your direction.\n- task split {id, cards: [{agent, title, doneWhen, estimateMinutes}], reason}: have the owner agent split its card into these child cards.\n- task reassign {id, agent, reason}: give the card to another agent, who continues it.\n- task decide {ask, decision}: make the call on a stuck ask; the asking card continues with your decision.\n- task escalate {id, question}: put one question to the owner in the main chat, only when no agent can decide.\nAct only on the cards the board scan flagged, pick the smallest action that unsticks each one, and end your turn when every flagged card has one. Every action is recorded on the card. Estimates are in agent minutes. Agents that can own a card: ${owners}.`;

export function cardOwners(registry: AgentRegistry) {
  return [...registry.agents.values()].filter(
    (agent) => agent.name !== routerAgent && agent.name !== pmAgent,
  );
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
  return `Start every card with agent set to the one agent that owns it, chosen from the team routing descriptions below, client set to the one client the work is for, and estimateMinutes in agent minutes. Give work you can't place more precisely to the team's lead. When the owner asks for a brainstorm, start a card with cardType ${brainstormCard} owned by the agent who should converge, and name in the brief any agents the owner wants in it. Take the client from the owner's words; when they don't make it clear, ask the owner which client with ask_user before starting the card.\n${teams.join('\n')}\nClients:\n${clients || 'none yet, so tell the owner a client config needs adding under agents/clients/'}`;
}

type BindingContext = Pick<RuntimeContext, 'threadId' | 'sessionId' | 'proactivity'>;

export function bindAgent(
  registry: AgentRegistry,
  context: BindingContext,
  cardAgent?: string,
  role: 'owner' | 'asked' | 'pm' = 'owner',
): { agent?: NonNullable<RuntimeContext['agent']> } {
  if (context.proactivity) return {};
  if (role === 'pm') {
    const config = registry.agents.get(pmAgent);
    const owners = cardOwners(registry)
      .map((agent) => `${agent.name} (${agent.title}: ${agent.role})`)
      .join(', ');
    return {
      agent: {
        name: pmAgent,
        title: config?.title ?? 'PM',
        tools: ['task'],
        instructions: `${config?.instructions ?? 'The PM config in agents/core/pm.md is missing or invalid, so you run with the built-in PM rules only.'}\n\n${pmRules(owners || 'none yet')}`,
      },
    };
  }
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
        instructions:
          role === 'asked'
            ? `The config for ${cardAgent} in agents/ is missing or invalid, so you can't help. Answer that the owner needs to fix this agent's config.\n${askRules}`
            : `The config for ${cardAgent} in agents/ is missing or invalid, so you can't do this card's work. Close the card with one question asking the owner to fix the config or reassign the card.\n${cardRules}`,
      },
    };
  return {
    agent: {
      name: config.name,
      title: config.title,
      tools: config.tools.includes('task') ? config.tools : [...config.tools, 'task'],
      instructions: `${config.instructions}\n\n${role === 'asked' ? askRules : cardRules}`,
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
  card: (
    sessionId: string,
  ) => Promise<
    | { agent: string; client: string | null; role: 'owner' | 'asked'; card_type: string | null }
    | undefined
  >;
  wallRecords: (
    sessionId: string,
    client: string | null,
  ) => Promise<{ sessionTurns: ReadonlySet<string>; clientCards: ReadonlySet<string> }>;
  pmSession?: (sessionId: string) => Promise<boolean>;
  root?: string;
  skills?: AgentSkillSources;
}) {
  const root = options.root ?? process.env.NOD_AGENTS_ROOT;
  if (!root)
    return {
      enabled: false,
      registry: async () => undefined,
      bind: async (_context: BindingContext): Promise<ReturnType<typeof bindAgent>> => ({}),
      participant: async (_name: string): Promise<BrainstormParticipant | undefined> => undefined,
    };
  let reported = '';
  const load = async () => {
    const registry = await loadAgentRegistry(resolve(root), options.knownTools);
    const skills = loadAgentSkills(options.skills ?? {});
    rejectMissingSkills(registry, skills);
    const problems = JSON.stringify(registry.problems);
    if (problems !== reported) {
      reported = problems;
      for (const { path, reason } of registry.problems)
        console.error(JSON.stringify({ event: 'agent_config_rejected', path, reason }));
    }
    return { registry, skills };
  };
  void load();
  return {
    enabled: true,
    registry: async () => (await load()).registry,
    bind: async (
      context: WallContext & Partial<Pick<RuntimeContext, 'emit'>>,
    ): Promise<Partial<RuntimeContext>> => {
      if (context.proactivity) return {};
      const chat = context.sessionId === context.threadId;
      if (!chat && (await options.pmSession?.(context.sessionId)))
        return bindAgent((await load()).registry, context, pmAgent, 'pm');
      const card = chat ? undefined : await options.card(context.sessionId);
      if (!chat && !card) return {};
      const { registry, skills } = await load();
      const bound = bindAgent(registry, context, card?.agent, card?.role ?? 'owner');
      const config = registry.agents.get(card?.agent ?? routerAgent);
      let agent = bound.agent;
      if (agent && config) {
        const cardType = card?.role === 'owner' ? (card.card_type ?? undefined) : undefined;
        if (cardType === brainstormCard)
          agent = {
            ...agent,
            tools: [...agent.tools, 'brainstorm'],
            instructions: `${agent.instructions}\n${brainstormRules}`,
          };
        const names = requiredSkills(config, cardType);
        if (names.length) {
          agent = {
            ...agent,
            instructions: `${agent.instructions}\n\n${skillInstructions(skills, names)}`,
          };
          if (card) await context.emit?.('step', `Loaded skills: ${names.join(', ')}`);
        }
      }
      if (!card || !agent) return agent ? { agent } : {};
      return wallCard(
        { ...context, history: context.history ?? [], agent },
        {
          client: card.client,
          clients: registry.clients,
          namespaces: options.namespaces,
          ...(await options.wallRecords(context.sessionId, card.client)),
        },
      );
    },
    participant: async (name: string): Promise<BrainstormParticipant | undefined> => {
      const { registry, skills } = await load();
      const config = registry.agents.get(name);
      if (!config || name === routerAgent || name === pmAgent) return undefined;
      const names = requiredSkills(config, brainstormCard);
      return {
        name,
        title: config.title,
        tools: config.tools,
        instructions: [
          config.instructions,
          participantRules,
          ...(names.length ? [skillInstructions(skills, names)] : []),
        ].join('\n\n'),
      };
    },
  };
}
