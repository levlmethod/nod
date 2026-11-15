import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ConnectedMcpServer } from '../../ports/agent.ts';
import { enqueueTurn } from '../thread.ts';
import { transaction } from '../transaction.ts';
import { serverOwned, type ClientConfig } from './clients.ts';
import { cardOwners, type AgentRegistry } from './registry.ts';
import {
  checkThreshold,
  readSeries,
  writeRefusal,
  type Threshold,
  type Trip,
} from './thresholds.ts';

export type WatcherCall = {
  connectionId: string;
  pathId: string;
  tool: string;
  input: Record<string, unknown>;
};

type Anomaly = { key: string; client: string; name: string; trip: Trip };

const defaultEstimate = 30;
const hourMs = 60 * 60 * 1000;

export function createWatchers(options: {
  pool: Pool;
  ownerId: string;
  registry: () => Promise<AgentRegistry | undefined>;
  servers: () => Promise<ConnectedMcpServer[]>;
  call: (call: WatcherCall) => Promise<unknown>;
  problem?: (reason: string) => void;
}) {
  const { pool, ownerId } = options;
  const problem =
    options.problem ??
    ((reason: string) => console.error(JSON.stringify({ event: 'watcher_check_failed', reason })));

  async function check(
    client: ClientConfig,
    threshold: Threshold,
    servers: ConnectedMcpServer[],
    timeZone: string,
  ): Promise<Trip | undefined> {
    const server = servers.find(
      (item) =>
        serverOwned(client, item) &&
        [item.service, item.name].some(
          (label) => label.trim().toLowerCase() === threshold.source.service.trim().toLowerCase(),
        ),
    );
    if (!server)
      throw new Error(
        `${client.title} has no connected ${threshold.source.service} MCP server in its connections.`,
      );
    const refusal = writeRefusal(
      server.tools.find((tool) => tool.name === threshold.source.tool),
      threshold.source.tool,
    );
    if (refusal) throw new Error(refusal);
    const result = await options.call({
      connectionId: server.connectionId,
      pathId: server.pathId,
      tool: threshold.source.tool,
      input: threshold.source.input ?? {},
    });
    return checkThreshold(threshold, readSeries(result, threshold.source), { timeZone });
  }

  async function open(registry: AgentRegistry, anomaly: Anomaly, threshold: Threshold) {
    const client = registry.clients.get(anomaly.client)!;
    const agent = registry.agents.get(threshold.agent)!;
    return transaction(async (db: PoolClient) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${ownerId}:${anomaly.key}`]);
      const held = (
        await db.query(
          'SELECT 1 FROM watcher_cards WHERE owner_id=$1 AND anomaly_key=$2 AND cleared_at IS NULL',
          [ownerId, anomaly.key],
        )
      ).rowCount;
      if (held) return false;
      const taskId = randomUUID();
      const metric = `${threshold.source.tool} ${threshold.source.values}`;
      const prompt = `Watcher anomaly for ${client.title}: ${anomaly.name}. ${metric}: ${anomaly.trip.summary}\nFind out why this metric moved, using only ${client.title}'s connections. Close the card with the cause as the conclusion, the numbers as evidence, the proposed fix as nextAction with its tier (tier 1 if the fix only reads, drafts or reduces spend; tier 2 if it raises spend, publishes, reaches a customer or client, or deletes), and your confidence.`;
      const turnId = await enqueueTurn(prompt, {
        source: 'event',
        proactive: false,
        sessionId: taskId,
        background: true,
        client: db,
      });
      await db.query(
        `INSERT INTO tasks(id,owner_id,turn_id,session_id,title,done_when,brief,now_text,applied_revision)
         VALUES($1,$2,$3,$1,$4,$5,$6,$7,0)`,
        [
          taskId,
          ownerId,
          turnId,
          `${client.title}: ${anomaly.name} tripped`,
          'The cause of the metric change is known with evidence, and the card closes with a proposed fix and its tier.',
          prompt,
          'Investigating why the metric moved.',
        ],
      );
      await db.query('UPDATE turns SET task_id=$1 WHERE id=$2 AND owner_id=$3', [
        taskId,
        turnId,
        ownerId,
      ]);
      await db.query(
        `INSERT INTO agent_cards(task_id,owner_id,agent,client,card_type,estimate_minutes,budget_usd)
         VALUES($1,$2,$3,$4,'investigation',$5,$6)`,
        [
          taskId,
          ownerId,
          agent.name,
          client.name,
          threshold.estimateMinutes ?? defaultEstimate,
          agent.budget?.cardUsd ?? null,
        ],
      );
      await db.query(
        `INSERT INTO watcher_cards(owner_id,anomaly_key,task_id,latest,baseline,summary)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          ownerId,
          anomaly.key,
          taskId,
          anomaly.trip.latest,
          anomaly.trip.baseline ?? null,
          anomaly.trip.summary,
        ],
      );
      return true;
    }, pool);
  }

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS watcher_cards (
        owner_id text NOT NULL,
        anomaly_key text NOT NULL,
        task_id uuid NOT NULL REFERENCES tasks(id),
        latest double precision NOT NULL,
        baseline double precision,
        summary text NOT NULL,
        opened_at timestamptz NOT NULL DEFAULT now(),
        cleared_at timestamptz,
        PRIMARY KEY (owner_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS watcher_cards_key ON watcher_cards(owner_id,anomaly_key);
    `);
  }

  let initialized: Promise<void> | undefined;
  async function run() {
    const opened: string[] = [];
    const held: string[] = [];
    const registry = await options.registry();
    if (!registry) return { opened, held };
    await (initialized ??= initialize());
    const timeZone =
      (
        await pool.query<{ time_zone: string | null }>(
          'SELECT time_zone FROM preferences WHERE owner_id=$1',
          [ownerId],
        )
      ).rows[0]?.time_zone ?? 'UTC';
    const owners = new Set(cardOwners(registry).map((agent) => agent.name));
    let servers: ConnectedMcpServer[] | undefined;
    for (const client of registry.clients.values())
      for (const [name, threshold] of Object.entries(client.thresholds ?? {})) {
        const key = `${client.name}:${name}`;
        try {
          if (!owners.has(threshold.agent))
            throw new Error(`${threshold.agent} is not an agent that can own a card.`);
          servers ??= await options.servers();
          const trip = await check(client, threshold, servers, timeZone);
          if (!trip) {
            await pool.query(
              'UPDATE watcher_cards SET cleared_at=now() WHERE owner_id=$1 AND anomaly_key=$2 AND cleared_at IS NULL',
              [ownerId, key],
            );
            continue;
          }
          const anomaly = { key, client: client.name, name, trip };
          if (await open(registry, anomaly, threshold)) opened.push(key);
          else held.push(key);
        } catch (error) {
          problem(`Watcher ${key} failed: ${(error as Error).message}`);
        }
      }
    return { opened, held };
  }

  function start() {
    let running: Promise<unknown> | undefined;
    const tick = () => {
      running ??= run()
        .catch((error: unknown) => problem(`Watchers failed: ${(error as Error).message}`))
        .finally(() => {
          running = undefined;
        });
    };
    const first = setTimeout(tick, 60_000);
    const timer = setInterval(tick, hourMs);
    first.unref();
    timer.unref();
    return async () => {
      clearTimeout(first);
      clearInterval(timer);
      await running;
    };
  }

  return { initialize, run, start };
}
