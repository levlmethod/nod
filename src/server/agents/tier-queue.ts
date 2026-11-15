import type { Pool, PoolClient } from 'pg';
import type { ApprovalNote } from '../../shared/tiers.ts';
import { cardRefusal } from '../../shared/cards.ts';
import type { AgentRegistry } from './registry.ts';
import { actionTier, tierRules } from './tiers.ts';

export const tierInstructions =
  'Reads, research, drafts, cards and actions that only reduce spend, such as pausing an ad set, run without the owner. Anything that raises spend or might, publishes, sends to anyone, deletes or archives waits for the owner to say yes, in a queue for the morning digest. Just before such an action, call task update {id, approval: {why, ifWaiting}} saying why it is needed and what happens if the owner waits until morning. Add urgent with the reason only when waiting would cause real harm before the owner next looks, because urgent items notify the owner at once.';

type Card = { task_id: string; agent: string; client: string | null; title: string };

export type TierQueueItem = {
  approvalId: string;
  messageId: string;
  taskId: string;
  card: string;
  client: string | null;
  clientTitle: string;
  agent: string;
  agentTitle: string;
  action: string;
  title: string | null;
  args: Record<string, unknown>;
  why: string;
  ifWaiting: string;
  urgent: string | null;
  askedAt: Date;
};

export function createTierQueue(options: {
  pool: Pool;
  ownerId: string;
  registry: () => Promise<AgentRegistry | undefined>;
}) {
  const { pool, ownerId } = options;

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_approval_notes (
        task_id uuid PRIMARY KEY REFERENCES tasks(id),
        owner_id text NOT NULL,
        why text NOT NULL,
        if_waiting text NOT NULL,
        urgent text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS agent_tier_queue (
        approval_id uuid PRIMARY KEY REFERENCES approvals(id),
        owner_id text NOT NULL,
        message_id uuid NOT NULL,
        task_id uuid NOT NULL REFERENCES tasks(id),
        client text,
        agent text NOT NULL,
        why text NOT NULL,
        if_waiting text NOT NULL,
        urgent text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS agent_tier_queue_held ON agent_tier_queue(owner_id) WHERE urgent IS NULL;
    `);
  }

  async function cardOf(client: Pick<Pool, 'query'>, turnId: string) {
    return (
      await client.query<Card>(
        `SELECT c.task_id,c.agent,c.client,t.title FROM turns u
         JOIN tasks t ON t.session_id=u.session_id AND t.owner_id=u.owner_id
         JOIN agent_cards c ON c.task_id=t.id AND c.owner_id=t.owner_id
         WHERE u.id=$1 AND u.owner_id=$2`,
        [turnId, ownerId],
      )
    ).rows[0];
  }

  async function names(card: Card, registry?: AgentRegistry) {
    registry ??= await options.registry();
    const agent = registry?.agents.get(card.agent);
    const client = card.client ? registry?.clients.get(card.client) : undefined;
    return {
      agent: { name: card.agent, title: agent?.title ?? card.agent },
      client: {
        name: card.client ?? 'none',
        title: client?.title ?? card.client ?? 'no client',
        connections: client?.connections,
      },
    };
  }

  async function note(client: PoolClient, taskId: string, note: ApprovalNote) {
    const card = await client.query('SELECT 1 FROM agent_cards WHERE task_id=$1 AND owner_id=$2', [
      taskId,
      ownerId,
    ]);
    if (!card.rowCount)
      throw cardRefusal('Only a card takes an approval note. Leave approval out of this update.');
    await client.query(
      `INSERT INTO agent_approval_notes(task_id,owner_id,why,if_waiting,urgent) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(task_id) DO UPDATE SET why=$3,if_waiting=$4,urgent=$5,created_at=now()`,
      [taskId, ownerId, note.why, note.ifWaiting, note.urgent ?? null],
    );
  }

  async function trust(turn: { turnId: string }, action: string, args: Record<string, unknown>) {
    const card = await cardOf(pool, turn.turnId);
    if (!card) return undefined;
    const { agent, client } = await names(card);
    const tier = actionTier(action, args);
    return {
      rules: tierRules(agent, client),
      ...(tier?.tier === 2 ? { ask: tier.reason } : {}),
    };
  }

  async function asked(
    client: PoolClient,
    approval: { id: string; turn_id: string; confirmation_message_id: string },
  ) {
    const card = await cardOf(client, approval.turn_id);
    if (!card) return;
    const saved = (
      await client.query<{
        why: string;
        if_waiting: string;
        urgent: string | null;
        fresh: boolean;
      }>(
        `DELETE FROM agent_approval_notes WHERE task_id=$1 AND owner_id=$2
         RETURNING why,if_waiting,urgent,created_at>now()-interval '10 minutes' AS fresh`,
        [card.task_id, ownerId],
      )
    ).rows.find((row) => row.fresh);
    const why = saved?.why ?? `Card: ${card.title}`;
    const ifWaiting = saved?.if_waiting ?? "The agent didn't say.";
    const urgent = saved?.urgent ?? null;
    await client.query(
      `INSERT INTO agent_tier_queue(approval_id,owner_id,message_id,task_id,client,agent,why,if_waiting,urgent)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        approval.id,
        ownerId,
        approval.confirmation_message_id,
        card.task_id,
        card.client,
        card.agent,
        why,
        ifWaiting,
        urgent,
      ],
    );
  }

  async function held(messageIds: string[]) {
    return (
      await pool.query<{ message_id: string }>(
        `SELECT message_id FROM agent_tier_queue WHERE owner_id=$1 AND urgent IS NULL
         AND message_id=ANY($2::uuid[])`,
        [ownerId, messageIds],
      )
    ).rows.map((row) => row.message_id);
  }

  async function list(): Promise<TierQueueItem[]> {
    const rows = (
      await pool.query(
        `SELECT q.*,a.action,a.title AS action_title,a.args,t.title AS card FROM agent_tier_queue q
         JOIN approvals a ON a.id=q.approval_id AND a.owner_id=q.owner_id
         JOIN turns u ON u.id=a.turn_id AND u.owner_id=a.owner_id
         JOIN tasks t ON t.id=q.task_id AND t.owner_id=q.owner_id
         WHERE q.owner_id=$1 AND a.status='pending' AND u.status IN ('running','waiting')
         ORDER BY q.urgent IS NULL,q.created_at`,
        [ownerId],
      )
    ).rows;
    const registry = await options.registry();
    return Promise.all(
      rows.map(async (row) => {
        const { agent, client } = await names(
          {
            task_id: row.task_id,
            agent: row.agent,
            client: row.client,
            title: row.card,
          },
          registry,
        );
        return {
          approvalId: row.approval_id,
          messageId: row.message_id,
          taskId: row.task_id,
          card: row.card,
          client: row.client,
          clientTitle: client.title,
          agent: agent.name,
          agentTitle: agent.title,
          action: row.action,
          title: row.action_title,
          args: row.args,
          why: row.why,
          ifWaiting: row.if_waiting,
          urgent: row.urgent,
          askedAt: row.created_at,
        };
      }),
    );
  }

  return { initialize, note, trust, asked, held, list };
}

export const heldMessageSql = (message: string) =>
  `EXISTS (SELECT 1 FROM agent_tier_queue h WHERE h.message_id=${message}.id AND h.owner_id=${message}.owner_id AND h.urgent IS NULL)`;
