import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  askLimit,
  cardAnswer,
  cardAsk,
  cardRefusal,
  cardResult,
  cardResultText,
  type CardView,
} from '../../shared/cards.ts';
import {
  enqueueTurn,
  lockThread,
  resumeTurn,
  wakeThreadAt,
  withTurnLock,
  type TurnRef,
} from '../thread.ts';
import { transaction } from '../transaction.ts';
import { cardOwners, type AgentRegistry } from './registry.ts';

type StartRequest = {
  agent?: string;
  client?: string;
  cardType?: string;
  estimateMinutes?: number;
  blockedBy?: string[];
};
type FinishRequest = { result?: string; card?: unknown; question?: string };

export type CardHooks = {
  start(
    client: PoolClient,
    start: { chat: boolean; taskId: string; request: StartRequest; parent?: string },
  ): Promise<{ hold: boolean } | void>;
  finish(client: PoolClient, taskId: string, request: FinishRequest): Promise<string>;
  closed(client: PoolClient): Promise<void>;
};

type Exchange = { question: string; answer?: string; unanswered?: boolean };

const unsettled = (task: string) =>
  `(${task}.state='open' OR (${task}.state='done' AND EXISTS(SELECT 1 FROM agent_cards q
    WHERE q.task_id=${task}.id AND q.owner_id=${task}.owner_id AND q.result ? 'question')))`;

const waitStarted = (turn: string) =>
  `(SELECT min(e.created_at) FROM turn_events e WHERE e.turn_id=${turn}.id AND e.type IN ('waiting','card_question'))`;

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
      ALTER TABLE agent_cards ADD COLUMN IF NOT EXISTS parent_task_id uuid REFERENCES tasks(id);
      ALTER TABLE agent_cards ADD COLUMN IF NOT EXISTS blocked_by uuid[] NOT NULL DEFAULT '{}';
      CREATE INDEX IF NOT EXISTS agent_cards_parent ON agent_cards(owner_id,parent_task_id)
        WHERE parent_task_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS agent_card_asks (
        id uuid PRIMARY KEY,
        owner_id text NOT NULL,
        task_id uuid NOT NULL REFERENCES tasks(id),
        from_agent text NOT NULL,
        to_agent text NOT NULL,
        exchanges jsonb NOT NULL DEFAULT '[]',
        flagged_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_id, task_id, to_agent)
      );
      CREATE TABLE IF NOT EXISTS agent_card_actions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id text NOT NULL,
        task_id uuid NOT NULL REFERENCES tasks(id),
        actor text NOT NULL,
        action text NOT NULL,
        reason text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS agent_card_actions_task ON agent_card_actions(owner_id,task_id,created_at);
    `);
  }

  const start: CardHooks['start'] = async (client, { chat, taskId, request, parent }) => {
    const named =
      request.agent ??
      request.client ??
      request.cardType ??
      request.estimateMinutes ??
      request.blockedBy;
    if (!chat && !parent) {
      if (named !== undefined)
        throw cardRefusal(
          'Only the Router or a card agent splitting its card starts cards. Start this as a plain task.',
        );
      return;
    }
    const parentCard = parent
      ? (
          await client.query<{ client: string | null }>(
            'SELECT client FROM agent_cards WHERE task_id=$1 AND owner_id=$2',
            [parent, ownerId],
          )
        ).rows[0]
      : undefined;
    if (parent && !parentCard)
      throw cardRefusal(
        'Only the Router or a card agent splitting its card starts cards. Start this as a plain task.',
      );
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
    if (parentCard && request.client && request.client !== parentCard.client)
      throw cardRefusal(
        `A child card stays with its parent's client, ${parentCard.client}, so it can't be for ${request.client}. Leave client out or start the work from a ${request.client} card.`,
      );
    const cardClient = parentCard ? parentCard.client : request.client;
    if (!cardClient)
      throw cardRefusal(
        `A card needs the one client it is for. Name it with client, one of: ${clients}. Ask the owner if their words don't say which.`,
      );
    if (!registry.clients.has(cardClient))
      throw cardRefusal(`${cardClient} is not a client. Use one of: ${clients}.`);
    if (!request.estimateMinutes)
      throw cardRefusal(
        'A card needs estimateMinutes: how many agent minutes the work should take.',
      );
    const blockedBy = [...new Set(request.blockedBy ?? [])];
    const blockers = (
      await client.query<{ task_id: string; state: string }>(
        `SELECT c.task_id,t.state FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND c.task_id=ANY($2::uuid[]) AND c.client=$3`,
        [ownerId, blockedBy, cardClient],
      )
    ).rows;
    const unknown = blockedBy.filter((id) => !blockers.some((row) => row.task_id === id));
    if (unknown.length)
      throw cardRefusal(
        `${unknown.join(', ')} is not a ${cardClient} card, so it can't block this one. Use card IDs for the same client from task list.`,
      );
    await client.query(
      `INSERT INTO agent_cards(task_id,owner_id,agent,client,card_type,estimate_minutes,budget_usd,parent_task_id,blocked_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        taskId,
        ownerId,
        owner.name,
        cardClient,
        request.cardType ?? 'work',
        request.estimateMinutes,
        owner.budget?.cardUsd ?? null,
        parent ?? null,
        blockedBy,
      ],
    );
    return { hold: blockers.some((row) => row.state === 'open') };
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
    if ('question' in result)
      await client.query(
        `INSERT INTO turn_events(id,turn_id,type,summary)
         SELECT gen_random_uuid(),u.id,'card_question','Closed with a question for the owner.'
         FROM turns u JOIN tasks t ON t.session_id=u.session_id AND t.owner_id=u.owner_id
         WHERE t.id=$1 AND t.owner_id=$2 AND u.status='running'`,
        [taskId, ownerId],
      );
    return cardResultText(result);
  };

  async function closedCards(client: PoolClient, ids: string[]) {
    const rows = (
      await client.query<{ title: string; agent: string; state: string; result: string }>(
        `SELECT t.title,c.agent,t.state,t.result FROM tasks t JOIN agent_cards c ON c.task_id=t.id AND c.owner_id=t.owner_id
         WHERE t.owner_id=$1 AND t.id=ANY($2::uuid[]) ORDER BY t.closed_at,t.id`,
        [ownerId, ids],
      )
    ).rows;
    return rows
      .map((row) => `- ${row.title} (${row.agent}, ${row.state}): ${row.result || 'no result'}`)
      .join('\n');
  }

  async function latestTurn(client: PoolClient, sessionId: string) {
    return (
      await client.query<{ id: string }>(
        `SELECT id FROM turns WHERE owner_id=$1 AND session_id=$2
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [ownerId, sessionId],
      )
    ).rows[0]?.id;
  }

  const closed: CardHooks['closed'] = async (client) => {
    const held = (
      await client.query<{ turn_id: string; blocked_by: string[] }>(
        `SELECT u.id AS turn_id,c.blocked_by FROM agent_cards c
         JOIN turns u ON u.task_id=c.task_id AND u.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND u.status='queued' AND u.start_after='infinity'
           AND NOT EXISTS(SELECT 1 FROM tasks b WHERE b.owner_id=c.owner_id AND b.id=ANY(c.blocked_by) AND ${unsettled('b')})
         FOR UPDATE OF u`,
        [ownerId],
      )
    ).rows;
    for (const row of held) {
      await client.query(
        `UPDATE turns SET start_after=NULL,prompt=prompt||$3 WHERE id=$1 AND owner_id=$2`,
        [
          row.turn_id,
          ownerId,
          `\n\nThe cards this card waited on have closed:\n${await closedCards(client, row.blocked_by)}`,
        ],
      );
    }
    const parents = (
      await client.query<{ task_id: string; session_id: string; children: string[] }>(
        `SELECT p.id AS task_id,p.session_id,array_agg(k.task_id ORDER BY k.task_id) AS children
         FROM tasks p JOIN agent_cards k ON k.parent_task_id=p.id AND k.owner_id=p.owner_id
         JOIN tasks kt ON kt.id=k.task_id AND kt.owner_id=k.owner_id
         WHERE p.owner_id=$1 AND p.state='open'
         GROUP BY p.id,p.session_id HAVING bool_and(NOT ${unsettled('kt')})`,
        [ownerId],
      )
    ).rows;
    for (const parent of parents) {
      const turnId = await latestTurn(client, parent.session_id);
      if (!turnId) continue;
      await resumeTurn(
        turnId,
        `card-children:${parent.task_id}:${createHash('sha256').update(parent.children.join(',')).digest('hex')}`,
        `Every child card of this card has closed:\n${await closedCards(client, parent.children)}\nUse their results to continue or close this card.`,
        false,
        client,
      );
    }
    if (held.length) await wakeThreadAt(client, new Date());
  };

  async function cardFor(sessionId: string) {
    return (
      await pool.query<{ agent: string; client: string | null; role: 'owner' | 'asked' }>(
        `SELECT c.agent,c.client,'owner' AS role FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND t.session_id=$2
         UNION ALL
         SELECT a.to_agent,c.client,'asked' FROM agent_card_asks a JOIN agent_cards c ON c.task_id=a.task_id AND c.owner_id=a.owner_id
         WHERE a.owner_id=$1 AND a.id=$2
         LIMIT 1`,
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

  async function askCard(client: PoolClient, turn: TurnRef, raw: unknown) {
    const request = cardAsk.parse(raw);
    const current = (
      await client.query<{ task_id: string | null; channel: string }>(
        'SELECT task_id,channel FROM turns WHERE id=$1 AND owner_id=$2',
        [turn.turnId, ownerId],
      )
    ).rows[0];
    const card = (
      await client.query<{
        agent: string;
        title: string;
        brief: string;
        done_when: string;
        state: string;
      }>(
        `SELECT c.agent,t.title,t.brief,t.done_when,t.state FROM agent_cards c
         JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND c.task_id=$2 FOR NO KEY UPDATE OF t`,
        [ownerId, request.id],
      )
    ).rows[0];
    if (!card || current?.task_id !== request.id)
      throw cardRefusal('Only the agent working a card can ask on it. Use your own card ID.');
    if (card.state !== 'open') throw cardRefusal('This card is closed, so it takes no more asks.');
    const registry = await options.registry();
    if (!registry)
      throw cardRefusal(
        'Agents are off, so asks are unavailable. Set NOD_AGENTS_ROOT to turn them on.',
      );
    const asked = cardOwners(registry).find((agent) => agent.name === request.agent);
    if (!asked || asked.name === card.agent)
      throw cardRefusal(
        `Ask another agent: one of ${cardOwners(registry)
          .filter((agent) => agent.name !== card.agent)
          .map((agent) => agent.name)
          .join(', ')}.`,
      );
    await client.query(
      `INSERT INTO agent_card_asks(id,owner_id,task_id,from_agent,to_agent)
       VALUES(gen_random_uuid(),$1,$2,$3,$4) ON CONFLICT (owner_id,task_id,to_agent) DO NOTHING`,
      [ownerId, request.id, card.agent, asked.name],
    );
    const ask = (
      await client.query<{ id: string; exchanges: Exchange[] }>(
        `SELECT id,exchanges FROM agent_card_asks WHERE owner_id=$1 AND task_id=$2 AND to_agent=$3 FOR UPDATE`,
        [ownerId, request.id, asked.name],
      )
    ).rows[0]!;
    if (ask.exchanges.some((exchange) => exchange.answer === undefined)) {
      const live = (
        await client.query(
          `SELECT 1 FROM turns WHERE owner_id=$1 AND session_id=$2 AND status IN ('queued','running','waiting')`,
          [ownerId, ask.id],
        )
      ).rowCount;
      if (live)
        throw cardRefusal(
          `You're still waiting for ${asked.title} to answer your last question. You'll be resumed with the answer.`,
        );
      ask.exchanges = ask.exchanges.map((exchange) =>
        exchange.answer === undefined ? { ...exchange, answer: '', unanswered: true } : exchange,
      );
      await client.query(
        `UPDATE agent_card_asks SET exchanges=$3,flagged_at=COALESCE(flagged_at,now()) WHERE id=$1 AND owner_id=$2`,
        [ask.id, ownerId, JSON.stringify(ask.exchanges)],
      );
    }
    if (ask.exchanges.length >= askLimit) {
      await client.query(
        'UPDATE agent_card_asks SET flagged_at=COALESCE(flagged_at,now()) WHERE id=$1 AND owner_id=$2',
        [ask.id, ownerId],
      );
      return {
        refused: `This ask with ${asked.title} has had its ${askLimit} back-and-forths, so it's flagged for the PM. Carry on with what you have, or close the card with one question for the owner.`,
      };
    }
    const exchanges = [...ask.exchanges, { question: request.question }];
    await client.query('UPDATE agent_card_asks SET exchanges=$3 WHERE id=$1 AND owner_id=$2', [
      ask.id,
      ownerId,
      JSON.stringify(exchanges),
    ]);
    const earlier = ask.exchanges
      .map(
        (exchange) =>
          `Q: ${exchange.question}\nA: ${exchange.unanswered ? '(no answer)' : exchange.answer}`,
      )
      .join('\n');
    await enqueueTurn(
      `${card.agent} asks you a question on their card "${card.title}". The card stays theirs: answer it, and don't take over the work.\nCard goal: ${card.brief || card.done_when}\nDone when: ${card.done_when}\n${earlier ? `Earlier on this ask:\n${earlier}\n` : ''}Question ${exchanges.length} of ${askLimit}: ${request.question}\nReply with task answer {id: "${ask.id}", answer}.`,
      {
        source: 'task',
        sessionId: ask.id,
        parentTurnId: turn.turnId,
        channel: current.channel,
        background: true,
        client,
      },
    );
    return {
      ask: ask.id,
      agent: asked.name,
      exchange: exchanges.length,
      left: askLimit - exchanges.length,
      next: `${asked.title} will answer on this card and you'll be resumed with the answer. Keep working on what doesn't depend on it, or end your turn.`,
    };
  }

  async function answerAsk(client: PoolClient, turn: TurnRef, raw: unknown) {
    const request = cardAnswer.parse(raw);
    const ask = (
      await client.query<{ task_id: string; to_agent: string; exchanges: Exchange[] }>(
        `SELECT a.task_id,a.to_agent,a.exchanges FROM agent_card_asks a JOIN turns u ON u.session_id=a.id AND u.owner_id=a.owner_id
         WHERE a.owner_id=$1 AND a.id=$2 AND u.id=$3 FOR UPDATE OF a`,
        [ownerId, request.id, turn.turnId],
      )
    ).rows[0];
    if (!ask) throw cardRefusal('Only the agent that was asked can answer, from its ask.');
    const pending = ask.exchanges.at(-1);
    if (!pending || pending.answer !== undefined)
      throw cardRefusal('This ask has no question waiting for an answer.');
    const exchanges = [...ask.exchanges.slice(0, -1), { ...pending, answer: request.answer }];
    await client.query('UPDATE agent_card_asks SET exchanges=$3 WHERE id=$1 AND owner_id=$2', [
      request.id,
      ownerId,
      JSON.stringify(exchanges),
    ]);
    const card = (
      await client.query<{ session_id: string; state: string }>(
        'SELECT session_id,state FROM tasks WHERE id=$1 AND owner_id=$2',
        [ask.task_id, ownerId],
      )
    ).rows[0]!;
    const asker = card.state === 'open' ? await latestTurn(client, card.session_id) : undefined;
    if (asker)
      await resumeTurn(
        asker,
        `card-ask:${request.id}:${exchanges.length}`,
        `${ask.to_agent} answered your question "${pending.question}":\n${request.answer}\nYou have ${askLimit - exchanges.length} back-and-forths left with ${ask.to_agent} on this card.`,
        false,
        client,
      );
    return { answered: true, exchange: exchanges.length };
  }

  async function act(turn: TurnRef, raw: unknown) {
    const action = (raw as { action?: unknown } | undefined)?.action;
    if (
      action !== 'ask' &&
      action !== 'answer' &&
      !(
        await pool.query(
          `SELECT 1 FROM agent_card_asks a JOIN turns u ON u.session_id=a.id AND u.owner_id=a.owner_id
           WHERE a.owner_id=$1 AND u.id=$2`,
          [ownerId, turn.turnId],
        )
      ).rowCount
    )
      return undefined;
    const work = async (client: PoolClient) => {
      if (action === 'ask') return askCard(client, turn, raw);
      if (action === 'answer') return answerAsk(client, turn, raw);
      const asked = (
        await client.query(
          `SELECT 1 FROM agent_card_asks a JOIN turns u ON u.session_id=a.id AND u.owner_id=a.owner_id
           WHERE a.owner_id=$1 AND u.id=$2`,
          [ownerId, turn.turnId],
        )
      ).rowCount;
      if (asked && action !== 'list')
        throw cardRefusal(
          "You were asked a question on another agent's card. Reply with task answer {id, answer}; you can't start or change cards from an ask.",
        );
      return undefined;
    };
    const result = await transaction(async (client) => {
      await lockThread(client);
      return withTurnLock(turn.turnId, () => work(client), client);
    }, pool);
    if (result && 'refused' in result && result.refused) throw cardRefusal(result.refused);
    return result;
  }

  async function read(taskIds?: string[]): Promise<CardView[]> {
    const rows = (
      await pool.query(
        `SELECT c.task_id,c.agent,c.client,c.budget_usd,c.card_type,c.parent_task_id,c.blocked_by,c.estimate_minutes,
           ARRAY(SELECT b.id FROM tasks b WHERE b.owner_id=c.owner_id AND b.id=ANY(c.blocked_by) AND ${unsettled('b')}) AS open_blockers,
           COALESCE((SELECT sum(extract(epoch FROM COALESCE(${waitStarted('u')},u.finished_at,CASE WHEN u.status='running' THEN now() END)-u.started_at))
             FROM turns u WHERE u.owner_id=c.owner_id AND u.started_at IS NOT NULL
               AND (u.session_id=t.session_id OR u.session_id IN (SELECT a.id FROM agent_card_asks a WHERE a.owner_id=c.owner_id AND a.task_id=c.task_id))),0) AS agent_seconds,
           COALESCE((SELECT sum(extract(epoch FROM COALESCE(
               (SELECT min(n.created_at) FROM turns n WHERE n.owner_id=w.owner_id AND n.session_id=w.session_id AND n.created_at>w.at),
               CASE WHEN ${unsettled('t')} THEN now() ELSE t.closed_at END)-w.at))
             FROM (SELECT u.owner_id,u.session_id,${waitStarted('u')} AS at FROM turns u
               WHERE u.owner_id=c.owner_id AND u.session_id=t.session_id) w WHERE w.at IS NOT NULL),0) AS waiting_seconds,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'agent',a.to_agent,'exchanges',a.exchanges,'flagged',a.flagged_at IS NOT NULL) ORDER BY a.created_at)
             FROM agent_card_asks a WHERE a.owner_id=c.owner_id AND a.task_id=c.task_id),'[]') AS asks
         FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND ($2::uuid[] IS NULL OR c.task_id=ANY($2::uuid[]))
         ORDER BY c.created_at,c.task_id`,
        [ownerId, taskIds ?? null],
      )
    ).rows;
    return rows.map((row) => ({
      taskId: row.task_id,
      agent: row.agent,
      client: row.client,
      budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
      cardType: row.card_type,
      parentTaskId: row.parent_task_id,
      blockedBy: row.blocked_by,
      openBlockers: row.open_blockers,
      estimateMinutes: row.estimate_minutes,
      agentMinutes: Number(row.agent_seconds) / 60,
      waitingMinutes: Number(row.waiting_seconds) / 60,
      asks: (
        row.asks as { id: string; agent: string; exchanges: Exchange[]; flagged: boolean }[]
      ).map((ask) => ({
        id: ask.id,
        agent: ask.agent,
        exchanges: ask.exchanges.length,
        pending: ask.exchanges.some((exchange) => exchange.answer === undefined),
        flagged: ask.flagged || ask.exchanges.some((exchange) => exchange.unanswered),
      })),
    }));
  }

  async function recordAction(
    action: { taskId: string; actor: string; action: string; reason: string },
    client: Pick<PoolClient, 'query'> = pool,
  ) {
    const { rowCount } = await client.query(
      `INSERT INTO agent_card_actions(owner_id,task_id,actor,action,reason)
       SELECT owner_id,task_id,$3,$4,$5 FROM agent_cards WHERE owner_id=$1 AND task_id=$2`,
      [ownerId, action.taskId, action.actor, action.action, action.reason],
    );
    if (!rowCount) throw cardRefusal(`${action.taskId} is not a card, so no action was recorded.`);
  }

  return {
    initialize,
    recordAction,
    hooks: { start, finish, closed } satisfies CardHooks,
    cardFor,
    wallRecords,
    isCardTurn,
    act,
    read,
  };
}
