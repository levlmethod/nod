import type { Pool, PoolClient } from 'pg';
import { cardRefusal, cardResult, cardResultText } from '../../shared/cards.ts';
import { cardOwners, type AgentRegistry } from './registry.ts';

type StartRequest = {
  agent?: string;
  client?: string;
  cardType?: string;
  estimateMinutes?: number;
};
type FinishRequest = { result?: string; card?: unknown; question?: string };

export type CardHooks = {
  start(
    client: PoolClient,
    start: { chat: boolean; taskId: string; request: StartRequest },
  ): Promise<void>;
  finish(client: PoolClient, taskId: string, request: FinishRequest): Promise<string>;
};

export function createCards(options: {
  pool: Pool;
  ownerId: string;
  registry: () => Promise<AgentRegistry | undefined>;
}) {
  const { pool, ownerId } = options;

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_cards (
        task_id uuid PRIMARY KEY REFERENCES tasks(id),
        owner_id text NOT NULL,
        agent text NOT NULL,
        card_type text NOT NULL DEFAULT 'work',
        estimate_minutes integer NOT NULL CHECK (estimate_minutes > 0),
        budget_usd numeric,
        result jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE agent_cards ADD COLUMN IF NOT EXISTS client text;
      CREATE INDEX IF NOT EXISTS agent_cards_client ON agent_cards(owner_id,client);
    `);
  }

  const start: CardHooks['start'] = async (client, { chat, taskId, request }) => {
    const named = request.agent ?? request.client ?? request.cardType ?? request.estimateMinutes;
    if (!chat) {
      if (named !== undefined)
        throw cardRefusal('Only the Router starts cards. Start this as a plain task.');
      return;
    }
    const registry = await options.registry();
    if (!registry) {
      if (named !== undefined)
        throw cardRefusal(
          'Agents are off, so cards are unavailable. Set NOD_AGENTS_ROOT to turn them on.',
        );
      return;
    }
    const owners = cardOwners(registry);
    const names = owners.map((agent) => agent.name).join(', ');
    if (!owners.length)
      throw cardRefusal(
        'No agent can own a card yet. Add an agent config under agents/ before starting cards.',
      );
    if (!request.agent)
      throw cardRefusal(`A card needs one owner agent. Name it with agent, one of: ${names}.`);
    const owner = owners.find((agent) => agent.name === request.agent);
    if (!owner)
      throw cardRefusal(
        `${request.agent} is not an agent that can own a card. Use one of: ${names}.`,
      );
    const clients = [...registry.clients.keys()].join(', ');
    if (!registry.clients.size)
      throw cardRefusal(
        'No client is set up yet. Add a client config under agents/clients/ before starting cards.',
      );
    if (!request.client)
      throw cardRefusal(
        `A card needs the one client it is for. Name it with client, one of: ${clients}. Ask the owner if their words don't say which.`,
      );
    if (!registry.clients.has(request.client))
      throw cardRefusal(`${request.client} is not a client. Use one of: ${clients}.`);
    if (!request.estimateMinutes)
      throw cardRefusal(
        'A card needs estimateMinutes: how many agent minutes the work should take.',
      );
    await client.query(
      `INSERT INTO agent_cards(task_id,owner_id,agent,client,card_type,estimate_minutes,budget_usd)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        taskId,
        ownerId,
        owner.name,
        request.client,
        request.cardType ?? 'work',
        request.estimateMinutes,
        owner.budget?.cardUsd ?? null,
      ],
    );
  };

  const finish: CardHooks['finish'] = async (client, taskId, request) => {
    const card = (
      await client.query(
        'SELECT task_id FROM agent_cards WHERE task_id=$1 AND owner_id=$2 FOR NO KEY UPDATE',
        [taskId, ownerId],
      )
    ).rows[0];
    if (!card) {
      if (request.card !== undefined || request.question !== undefined)
        throw cardRefusal(
          'Only a card closes with card or question. Finish this task with result.',
        );
      if (!request.result?.trim()) throw cardRefusal('Finishing a task needs result.');
      return request.result.trim();
    }
    const result = cardResult(request);
    await client.query('UPDATE agent_cards SET result=$3 WHERE task_id=$1 AND owner_id=$2', [
      taskId,
      ownerId,
      JSON.stringify(result),
    ]);
    return cardResultText(result);
  };

  async function cardFor(sessionId: string) {
    return (
      await pool.query<{ agent: string; client: string | null }>(
        `SELECT c.agent,c.client FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND t.session_id=$2`,
        [ownerId, sessionId],
      )
    ).rows[0];
  }

  async function wallRecords(sessionId: string, client: string | null) {
    const [turns, cards] = await Promise.all([
      pool.query<{ id: string }>('SELECT id FROM turns WHERE owner_id=$1 AND session_id=$2', [
        ownerId,
        sessionId,
      ]),
      pool.query<{ task_id: string }>(
        'SELECT task_id FROM agent_cards WHERE owner_id=$1 AND client=$2',
        [ownerId, client],
      ),
    ]);
    return {
      sessionTurns: new Set(turns.rows.map((row) => row.id)),
      clientCards: new Set(cards.rows.map((row) => row.task_id)),
    };
  }

  async function isCardTurn(turnId: string) {
    return Boolean(
      (
        await pool.query(
          `SELECT 1 FROM turns u JOIN agent_cards c ON c.task_id=u.task_id AND c.owner_id=u.owner_id
           WHERE u.id=$1 AND u.owner_id=$2`,
          [turnId, ownerId],
        )
      ).rowCount,
    );
  }

  return {
    initialize,
    hooks: { start, finish } satisfies CardHooks,
    cardFor,
    wallRecords,
    isCardTurn,
  };
}
