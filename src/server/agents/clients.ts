import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import type { ConnectedMcpServer, RuntimeContext } from '../../ports/agent.ts';
import type { ConnectedApp } from '../../ports/integrations.ts';
import { configFile } from './config-file.ts';
import { thresholdsSchema, validateThresholds } from './thresholds.ts';

export const clientsFolder = 'clients';

const names = Type.Array(Type.String({ minLength: 1 }));

export const clientSchema = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    budget: Type.Object(
      { monthlyUsd: Type.Number({ exclusiveMinimum: 0 }) },
      { additionalProperties: false },
    ),
    connections: Type.Optional(
      Type.Array(
        Type.Object(
          { service: Type.String({ minLength: 1 }), account: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
      ),
    ),
    dataSources: Type.Optional(names),
    thresholds: Type.Optional(thresholdsSchema),
    inboxes: Type.Optional(
      Type.Array(
        Type.Union([
          Type.String({ minLength: 3 }),
          Type.Object(
            {
              address: Type.String({ minLength: 3 }),
              connection: Type.String({ minLength: 1 }),
              tool: Type.String({ minLength: 1 }),
              args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            },
            { additionalProperties: false },
          ),
        ]),
      ),
    ),
  },
  { additionalProperties: false },
);

export type ClientConfig = Static<typeof clientSchema> & { name: string; brief: string };

export async function loadClients(root: string, problem: (path: string, reason: string) => void) {
  const clients = new Map<string, ClientConfig>();
  const folder = join(root, clientsFolder);
  let files;
  try {
    files = (await readdir(folder, { withFileTypes: true })).filter(
      (file) => file.isFile() && file.name.endsWith('.md'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      problem(folder, `The client config folder could not be read: ${(error as Error).message}`);
    return clients;
  }
  for (const file of files) {
    const path = join(folder, file.name);
    try {
      const { fields, body } = configFile<Static<typeof clientSchema>>(
        clientSchema,
        await readFile(path, 'utf8'),
      );
      validateThresholds(fields.thresholds);
      const name = basename(file.name, '.md');
      clients.set(name, { ...fields, name, brief: body });
    } catch (error) {
      problem(path, (error as Error).message);
    }
  }
  return clients;
}

const same = (left: string | undefined, right: string) =>
  Boolean(left) && left!.trim().toLowerCase() === right.trim().toLowerCase();

function owns(client: ClientConfig, service: string[], accounts: Array<string | undefined>) {
  return (client.connections ?? []).some(
    (binding) =>
      service.some((name) => same(name, binding.service)) &&
      accounts.some((account) => same(account, binding.account)),
  );
}

const appOwned = (client: ClientConfig, app: ConnectedApp) =>
  owns(client, [app.slug, app.name], [app.accountEmail ?? undefined, app.accountName ?? undefined]);

export const serverOwned = (client: ClientConfig, server: ConnectedMcpServer) =>
  owns(client, [server.service, server.name], [server.accountName]);

type WallInput = Pick<
  RuntimeContext,
  'connectedApps' | 'mcpServers' | 'history' | 'tasks' | 'relatedConversation' | 'learnedSkills'
> & { agent: NonNullable<RuntimeContext['agent']> };

const sharedTools: Record<string, string> = {
  manage_personal_context:
    "The owner's memory, history, settings and usage are shared across every client",
  manage_apps: 'The app list holds every client’s accounts',
  sign_in: 'Saved logins belong to the owner, not to one client',
  browser_session: 'Saved browser sessions belong to the owner, not to one client',
  pay: 'Saved cards belong to the owner, not to one client',
  files: "The owner's computer holds every client's files",
};

export function wallCard(
  input: WallInput,
  card: {
    client: string | null;
    clients: Map<string, ClientConfig>;
    sessionTurns: ReadonlySet<string>;
    clientCards: ReadonlySet<string>;
    namespaces: (servers: ConnectedMcpServer[]) => string[];
  },
): Partial<RuntimeContext> & { agent: NonNullable<RuntimeContext['agent']> } {
  const client = card.client ? card.clients.get(card.client) : undefined;
  const label = client?.title ?? card.client ?? 'no client';
  const apps = client ? (input.connectedApps ?? []).filter((app) => appOwned(client, app)) : [];
  const servers = client
    ? (input.mcpServers ?? []).filter((item) => serverOwned(client, item))
    : [];
  const allowed = new Set([
    ...apps.flatMap((app) => (app.connectionId ? [app.connectionId] : [])),
    ...servers.map((server) => server.connectionId),
  ]);
  const namespaces = new Set(card.namespaces(servers));
  const learned = new Set((input.learnedSkills ?? []).map((skill) => skill.name));
  const owner = (connectionId: string) =>
    [...card.clients.values()].find(
      (other) =>
        other.name !== client?.name &&
        ((input.connectedApps ?? []).some(
          (app) => app.connectionId === connectionId && appOwned(other, app),
        ) ||
          (input.mcpServers ?? []).some(
            (server) => server.connectionId === connectionId && serverOwned(other, server),
          )),
    );
  const listed = apps.length
    ? apps
        .map((app) => `${app.name} (${app.accountEmail ?? app.accountName}): ${app.connectionId}`)
        .join('; ')
    : 'none';
  const refuse = (name: string, params: unknown) => {
    const shared = sharedTools[name];
    if (shared)
      return `${shared}, so a card for ${label} can't use ${name}. This card sees only ${label}'s brief, connections and cards.`;
    const request = (params ?? {}) as {
      action?: unknown;
      args?: { connectionId?: unknown };
      name?: unknown;
    };
    if (name === 'task' && request.action === 'list')
      return `The task list holds every client's cards, so a card for ${label} reads only its own client's cards from its context.`;
    if (
      name === 'skills' &&
      (request.action === 'save' || request.action === 'patch' || learned.has(String(request.name)))
    )
      return `Learned procedures are shared across every client, so a card for ${label} can't read or write them. Task guides still work.`;
    if (name.startsWith('mcp__')) {
      if (namespaces.has(name.split('__')[1] ?? '')) return undefined;
      return `${name} isn't one of ${label}'s connections, so this card can't use it. Add the connection to the client's config if it belongs to ${label}.`;
    }
    if (name !== 'apps') return undefined;
    const connectionId = request.args?.connectionId;
    if (typeof connectionId !== 'string' || !connectionId)
      return `A card for ${label} must name the connectionId of one of ${label}'s connections in args: ${listed}.`;
    if (allowed.has(connectionId)) return undefined;
    const other = owner(connectionId);
    return other
      ? `Connection ${connectionId} belongs to ${other.title}, not ${label}. Client data stays behind its wall, so this card can't use it.`
      : `Connection ${connectionId} isn't one of ${label}'s connections, so this card can't use it. ${label}'s connections: ${listed}.`;
  };
  const brief = client
    ? `You are working for the client ${client.title} (${client.name}). Everything on this card is for ${client.title} only: you see only its brief, connections and cards, and other clients' data is refused.\nClient brief, as the owner wrote it:\n${client.brief || '(empty)'}\nConnections for ${client.title}: ${[...apps.map((app) => `${app.name} (${app.accountEmail ?? app.accountName}) connectionId ${app.connectionId}`), ...servers.map((server) => `${server.name} (${server.accountName}) MCP server`)].join('; ') || 'none'}.`
    : `This card has ${card.client ? `the client ${card.client}, which has no valid config in agents/clients` : 'no client'}, so it can use no connections. Close it with one question asking the owner to fix the client config or restart the card for a client.`;
  return {
    agent: {
      ...input.agent,
      instructions: `${input.agent.instructions}\n\n${brief}`,
      wall: { client: card.client ?? '', refuse },
    },
    connectedApps: apps,
    mcpServers: servers,
    memory: '',
    memoryBrief: undefined,
    relatedConversation: undefined,
    learnedSkills: undefined,
    history: input.history.filter(
      (message) => typeof message.turnId === 'string' && card.sessionTurns.has(message.turnId),
    ),
    tasks: (input.tasks ?? []).filter((task) => card.clientCards.has(task.id)),
  };
}
