import type { Pool } from 'pg';
import type { AgentRegistry } from './registry.ts';

const zone = `COALESCE((SELECT time_zone FROM preferences WHERE owner_id=$1),'UTC')`;
const month = `date_trunc('month', now() AT TIME ZONE ${zone})`;
const monthStart = `(${month} AT TIME ZONE ${zone})`;
const monthKey = `to_char(${month},'YYYY-MM')`;

const dollars = (value: number) => `$${value.toFixed(2)}`;

export function createClientBudget(options: {
  pool: Pool;
  ownerId: string;
  registry: () => Promise<AgentRegistry | undefined>;
}) {
  const { pool, ownerId } = options;

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_budget_pauses (
        owner_id text NOT NULL,
        client text NOT NULL,
        month text NOT NULL,
        cap_usd double precision NOT NULL,
        spent_usd double precision NOT NULL,
        reason text NOT NULL,
        turn_id uuid NOT NULL,
        paused_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, client, month)
      );
    `);
  }

  async function spent() {
    const { rows } = await pool.query<{ client: string; spent: number }>(
      `SELECT c.client,COALESCE(sum(m.cost_usd::text::numeric),0)::float8 AS spent
       FROM model_usage m LEFT JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
       JOIN tasks t ON t.owner_id=m.owner_id AND t.session_id=COALESCE(m.session_id,u.session_id)
       JOIN agent_cards c ON c.task_id=t.id AND c.owner_id=t.owner_id
       WHERE m.owner_id=$1 AND c.client IS NOT NULL AND m.created_at>=${monthStart}
       GROUP BY c.client`,
      [ownerId],
    );
    return new Map(rows.map((row) => [row.client, row.spent]));
  }

  async function spend() {
    const [registry, totals, pauses] = await Promise.all([
      options.registry(),
      spent(),
      pool.query<{ client: string; reason: string; paused_at: Date }>(
        `SELECT client,reason,paused_at FROM client_budget_pauses WHERE owner_id=$1 AND month=${monthKey}`,
        [ownerId],
      ),
    ]);
    if (!registry) return [];
    const paused = new Map(pauses.rows.map((row) => [row.client, row]));
    return [...registry.clients.values()].map((client) => ({
      client: client.name,
      title: client.title,
      capUsd: client.budget.monthlyUsd,
      spentUsd: totals.get(client.name) ?? 0,
      ...(paused.has(client.name)
        ? { pausedAt: paused.get(client.name)!.paused_at, reason: paused.get(client.name)!.reason }
        : {}),
    }));
  }

  async function admit(turn: { turnId: string; currentMessageId?: string }, client?: string) {
    if (!client || turn.currentMessageId) return;
    const config = (await options.registry())?.clients.get(client);
    if (!config) return;
    const spentUsd = (await spent()).get(client) ?? 0;
    const capUsd = config.budget.monthlyUsd;
    if (spentUsd < capUsd) return;
    const reason = `${config.title} has used ${dollars(spentUsd)} of its ${dollars(capUsd)} monthly model budget, so its cards are paused until next month or until the owner raises budget.monthlyUsd in agents/clients/${client}.md. A reply from the owner on the card still runs.`;
    await pool.query(
      `INSERT INTO client_budget_pauses(owner_id,client,month,cap_usd,spent_usd,reason,turn_id)
       VALUES($1,$2,${monthKey},$3,$4,$5,$6)
       ON CONFLICT (owner_id,client,month) DO UPDATE SET cap_usd=EXCLUDED.cap_usd,
         spent_usd=EXCLUDED.spent_usd,reason=EXCLUDED.reason,turn_id=EXCLUDED.turn_id,paused_at=now()`,
      [ownerId, client, capUsd, spentUsd, reason, turn.turnId],
    );
    throw new Error(reason);
  }

  return { initialize, spend, admit };
}
