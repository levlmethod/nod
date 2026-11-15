import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ConnectedMcpServer } from '../../ports/agent.ts';
import type { DiscoveredTool } from '../../ports/discovered.ts';
import { transaction } from '../transaction.ts';
import type { createAppGrantVault } from '../vault-app-grants.ts';
import type { WatcherCall } from './watchers.ts';

const origin = 'https://backstage.taboola.com';
const timeoutMs = 30_000;
const dayMs = 86_400_000;

export type TaboolaCredentials = { clientId: string; clientSecret: string; accountId: string };

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const failed = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

const zone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const dimensions = [
  'day',
  'week',
  'month',
  'campaign_breakdown',
  'campaign_day_breakdown',
  'site_breakdown',
  'country_breakdown',
  'platform_breakdown',
] as const;

const summaryInput = z
  .object({
    dimension: z.enum(dimensions).default('day'),
    days: z.number().int().min(1).max(90).default(14),
    monthToDate: z.boolean().default(false),
    includeToday: z.boolean().default(false),
    timeZone: z
      .string()
      .refine(zone, { message: 'timeZone must be an IANA time zone, such as America/New_York.' })
      .default('UTC'),
    campaign: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

const noInput = { type: 'object', properties: {}, additionalProperties: false };

export const taboolaTools: DiscoveredTool[] = [
  {
    name: 'get_account',
    description: 'Read the Taboola advertiser account this connection is bound to.',
    inputSchema: noInput,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_campaigns',
    description: "List the account's campaigns with their status, bid and spending limit.",
    inputSchema: noInput,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_campaign_summary',
    description:
      'Read spend and performance (spent, clicks, impressions, cpc, cpa, conversions, roas) from the campaign summary report. Day rows come oldest first. The range is the last `days` days through yesterday, or the month to date with `monthToDate`; `includeToday` adds the partial current day.',
    inputSchema: {
      type: 'object',
      properties: {
        dimension: { type: 'string', enum: dimensions },
        days: { type: 'integer', minimum: 1, maximum: 90 },
        monthToDate: { type: 'boolean' },
        includeToday: { type: 'boolean' },
        timeZone: {
          type: 'string',
          description: 'IANA time zone that decides which day is today.',
        },
        campaign: { type: 'string', description: 'Only this campaign ID.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

function localDay(now: Date, timeZone: string) {
  const text = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${text}T00:00:00Z`);
}

const isoDay = (day: Date) => day.toISOString().slice(0, 10);

function result(data: unknown) {
  return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function taboolaSource(
  credentials: TaboolaCredentials,
  options: { fetch?: Fetch; now?: () => Date } = {},
) {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const account = encodeURIComponent(credentials.accountId);
  let token: { value: string; expires: number } | undefined;

  const hide = (text: string) =>
    [credentials.clientSecret, token?.value]
      .filter((value): value is string => Boolean(value))
      .reduce((all, secret) => all.replaceAll(secret, '[hidden]'), text);

  async function failure(response: Response, what: string): Promise<never> {
    const text = await response.text().catch(() => '');
    let reason = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const named = [body.message, body.error_description, body.error].find(
        (value) => typeof value === 'string' && value,
      );
      if (named) reason = String(named);
    } catch {}
    throw failed(
      `Taboola ${what} failed with status ${response.status}${reason ? `: ${hide(reason)}` : '.'}`,
      502,
    );
  }

  async function request(what: string, url: string | URL, init: RequestInit) {
    try {
      return await send(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw failed(`Taboola ${what} did not answer: ${hide((error as Error).message)}`, 502);
    }
  }

  async function authorize() {
    if (token && token.expires > now().getTime() + 60_000) return token.value;
    const response = await request('sign-in', `${origin}/backstage/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: 'client_credentials',
      }).toString(),
    });
    if (!response.ok) return failure(response, 'sign-in');
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token)
      throw failed('Taboola sign-in answered without an access token.', 502);
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    token = { value: body.access_token, expires: now().getTime() + seconds * 1000 };
    return token.value;
  }

  async function read(path: string, query: Record<string, string> = {}, retry = true) {
    const url = new URL(`/backstage/api/1.0/${path}`, origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await request(`read of ${url.pathname}`, url, {
      method: 'GET',
      headers: { authorization: `Bearer ${await authorize()}`, accept: 'application/json' },
    });
    if (response.status === 401 && retry) {
      token = undefined;
      return read(path, query, false);
    }
    if (!response.ok) return failure(response, `read of ${url.pathname}`);
    return (await response.json()) as Record<string, unknown>;
  }

  async function allowed() {
    const body = await read('users/current/allowed-accounts');
    const accounts = Array.isArray(body.results)
      ? (body.results as Array<{ account_id?: unknown; name?: unknown }>)
      : [];
    const found = accounts.find((item) => item.account_id === credentials.accountId);
    if (!found)
      throw failed(
        `${credentials.accountId} is not an account these credentials can read. Taboola lists ${accounts.length} other account${accounts.length === 1 ? '' : 's'} for them.`,
        409,
      );
    return found;
  }

  async function summary(raw: Record<string, unknown>) {
    const input = summaryInput.parse(raw);
    const today = localDay(now(), input.timeZone);
    const end = input.includeToday ? today : new Date(today.getTime() - dayMs);
    const start = input.monthToDate
      ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      : new Date(end.getTime() - (input.days - 1) * dayMs);
    if (end < start) end.setTime(start.getTime());
    const body = await read(`${account}/reports/campaign-summary/dimensions/${input.dimension}`, {
      start_date: isoDay(start),
      end_date: isoDay(end),
      ...(input.campaign ? { campaign: input.campaign } : {}),
    });
    if (Array.isArray(body.results))
      body.results = [...(body.results as Array<{ date?: unknown }>)].sort((left, right) =>
        String(left.date ?? '').localeCompare(String(right.date ?? '')),
      );
    return body;
  }

  async function call(tool: string, input: Record<string, unknown>) {
    if (tool === 'get_account') return result(await allowed());
    if (tool === 'list_campaigns') return result(await read(`${account}/campaigns`));
    if (tool === 'get_campaign_summary') return result(await summary(input));
    throw new Error(
      `${tool} is not a Taboola tool. The Taboola connection only reads: ${taboolaTools.map((item) => item.name).join(', ')}.`,
    );
  }

  return { call, verify: allowed };
}

const connectInput = z
  .object({
    clientId: z.string().trim().min(8).max(200),
    clientSecret: z.string().trim().min(8).max(500),
    accountId: z.string().trim().min(1).max(200),
  })
  .strict();

type ConnectionRow = { id: string; account_id: string; account_name: string; created_at: Date };

export function createTaboola(options: {
  pool: Pool;
  ownerId: string;
  grantVault: Awaited<ReturnType<typeof createAppGrantVault>>;
  fetch?: Fetch;
  now?: () => Date;
}) {
  const { pool, ownerId, grantVault } = options;
  const connected = new Set<string>();
  const sources = new Map<string, { version: number; source: ReturnType<typeof taboolaSource> }>();
  const source = (credentials: TaboolaCredentials) =>
    taboolaSource(credentials, { fetch: options.fetch, now: options.now });

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS taboola_connections (
        id uuid PRIMARY KEY,
        owner_id text NOT NULL,
        account_id text NOT NULL,
        account_name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_id, account_id)
      );
    `);
  }

  async function rows() {
    return (
      await pool.query<ConnectionRow>(
        'SELECT id,account_id,account_name,created_at FROM taboola_connections WHERE owner_id=$1 ORDER BY created_at',
        [ownerId],
      )
    ).rows;
  }

  async function list() {
    return (await rows()).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      connectedAt: row.created_at.toISOString(),
    }));
  }

  async function connect(raw: unknown) {
    const credentials = connectInput.parse(raw);
    const found = await source(credentials).verify();
    const accountName =
      typeof found.name === 'string' && found.name ? found.name : credentials.accountId;
    const id = await transaction(async (db) => {
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO taboola_connections(id,owner_id,account_id,account_name)
           VALUES(gen_random_uuid(),$1,$2,$3)
           ON CONFLICT(owner_id,account_id) DO UPDATE SET account_name=excluded.account_name
           RETURNING id`,
          [ownerId, credentials.accountId, accountName],
        )
      ).rows[0]!.id;
      await grantVault.put(id, JSON.stringify(credentials), db);
      return id;
    }, pool);
    sources.delete(id);
    return { id, accountId: credentials.accountId, accountName };
  }

  async function disconnect(id: string) {
    const valid = z.uuid().parse(id);
    await transaction(async (db) => {
      const removed = await db.query(
        'DELETE FROM taboola_connections WHERE owner_id=$1 AND id=$2',
        [ownerId, valid],
      );
      if (!removed.rowCount) throw failed('This Taboola connection is not connected.', 404);
      await grantVault.remove(valid, db);
    }, pool);
    sources.delete(valid);
  }

  async function servers(): Promise<ConnectedMcpServer[]> {
    const current = await rows();
    connected.clear();
    for (const row of current) connected.add(row.id);
    return current.map((row) => ({
      connectionId: row.id,
      pathId: row.id,
      service: 'taboola',
      name: 'Taboola',
      accountName: row.account_id,
      tools: taboolaTools,
    }));
  }

  async function call(input: WatcherCall) {
    const grant = await grantVault.read(input.connectionId);
    let held = sources.get(input.connectionId);
    if (held?.version !== grant.version) {
      held = {
        version: grant.version,
        source: source(connectInput.parse(JSON.parse(grant.value))),
      };
      sources.set(input.connectionId, held);
    }
    return held.source.call(input.tool, input.input);
  }

  function alongside(other: {
    servers: () => Promise<ConnectedMcpServer[]>;
    call: (input: WatcherCall) => Promise<unknown>;
  }) {
    return {
      servers: async () => [...(await other.servers()), ...(await servers())],
      call: (input: WatcherCall) =>
        connected.has(input.connectionId) ? call(input) : other.call(input),
    };
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/agents/taboola', async (_request, reply) =>
      reply.header('Cache-Control', 'no-store').send({ connections: await list() }),
    );
    app.post('/api/agents/taboola', async (request, reply) =>
      reply.header('Cache-Control', 'no-store').send(await connect(request.body)),
    );
    app.delete<{ Params: { id: string } }>('/api/agents/taboola/:id', async (request, reply) => {
      await disconnect(request.params.id);
      return reply.header('Cache-Control', 'no-store').send({ connections: await list() });
    });
  }

  return { initialize, list, connect, disconnect, servers, call, alongside, registerRoutes };
}
