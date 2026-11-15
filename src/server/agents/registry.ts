import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export async function loadAgentRegistry(root: string): Promise<AgentRegistry> {
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
    const files = (await readdir(path, { withFileTypes: true })).filter(
      (file) => file.isFile() && file.name.endsWith('.md'),
    );
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
          members.push({
            ...validated<Static<typeof agentSchema>>(agentSchema, fields),
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

export function bindAgent(
  registry: AgentRegistry,
  context: Pick<RuntimeContext, 'threadId' | 'sessionId' | 'proactivity'>,
): { agent?: NonNullable<RuntimeContext['agent']> } {
  if (context.sessionId !== context.threadId || context.proactivity) return {};
  const router = registry.agents.get(routerAgent);
  if (!router) return {};
  return {
    agent: {
      name: router.name,
      title: router.title,
      tools: router.tools,
      instructions: router.instructions,
    },
  };
}

export function createAgentBinding(
  root = process.env.NOD_AGENTS_ROOT || fileURLToPath(new URL('../../../agents/', import.meta.url)),
) {
  let reported = '';
  return async (context: Pick<RuntimeContext, 'threadId' | 'sessionId' | 'proactivity'>) => {
    const registry = await loadAgentRegistry(root);
    const problems = JSON.stringify(registry.problems);
    if (problems !== reported) {
      reported = problems;
      for (const { path, reason } of registry.problems)
        console.error(JSON.stringify({ event: 'agent_config_rejected', path, reason }));
    }
    return bindAgent(registry, context);
  };
}
