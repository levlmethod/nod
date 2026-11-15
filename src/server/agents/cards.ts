import type { Pool, PoolClient } from 'pg';
import { cardRefusal, cardResult, cardResultText } from '../../shared/cards.ts';
import { cardOwners, type AgentRegistry } from './registry.ts';

type StartRequest = { agent?: string; cardType?: string; estimateMinutes?: number };
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
    `);
  }

  const start: CardHooks['start'] = async (client, { chat, taskId, request }) => {
    const named = request.agent ?? request.cardType ?? request.estimateMinutes;
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
    if (!request.estimateMinutes)
      throw cardRefusal(
        'A card needs estimateMinutes: how many agent minutes the work should take.',
      );
    await client.query(
      `INSERT INTO agent_cards(task_id,owner_id,agent,card_type,estimate_minutes,budget_usd)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        taskId,
        ownerId,
        owner.name,
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
      await pool.query<{ agent: string; card_type: string }>(
        `SELECT c.agent,c.card_type FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND t.session_id=$2`,
        [ownerId, sessionId],
      )
    ).rows[0];
  }

  const agentFor = async (sessionId: string) => (await cardFor(sessionId))?.agent;
  const typeFor = async (sessionId: string) => (await cardFor(sessionId))?.card_type;

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
    agentFor,
    typeFor,
    isCardTurn,
  };
}
