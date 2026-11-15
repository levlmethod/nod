import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  BrainstormHooks,
  BrainstormParticipant,
  BrainstormRound,
} from '../../ports/brainstorm.ts';
import {
  askLimit,
  brainstormCard,
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
  participant?: (name: string) => Promise<BrainstormParticipant | undefined>;
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
      CREATE TABLE IF NOT EXISTS agent_brainstorms (
        task_id uuid PRIMARY KEY REFERENCES tasks(id),
        owner_id text NOT NULL,
        participants text[] NOT NULL,
        devils_advocate text NOT NULL,
        turn_id uuid,
        rounds jsonb,
        completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  const start: CardHooks['start'] = async (client, { chat, taskId, request, parent }) => {
    const named = request.agent ?? request.cardType ?? request.estimateMinutes ?? request.blockedBy;
    if (!chat && !parent) {
      if (named !== undefined)
        throw cardRefusal(
          'Only the Router or a card agent splitting its card starts cards. Start this as a plain task.',
        );
      return;
    }
    if (
      parent &&
      !(
        await client.query('SELECT 1 FROM agent_cards WHERE task_id=$1 AND owner_id=$2', [
          parent,
          ownerId,
        ])
      ).rowCount
    )
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
    if (!request.estimateMinutes)
      throw cardRefusal(
        'A card needs estimateMinutes: how many agent minutes the work should take.',
      );
    const blockedBy = [...new Set(request.blockedBy ?? [])];
    const blockers = (
      await client.query<{ task_id: string; state: string }>(
        `SELECT c.task_id,t.state FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND c.task_id=ANY($2::uuid[])`,
        [ownerId, blockedBy],
      )
    ).rows;
    const unknown = blockedBy.filter((id) => !blockers.some((row) => row.task_id === id));
    if (unknown.length)
      throw cardRefusal(
        `${unknown.join(', ')} is not a card, so it can't block this one. Use card IDs from task list.`,
      );
    await client.query(
      `INSERT INTO agent_cards(task_id,owner_id,agent,card_type,estimate_minutes,budget_usd,parent_task_id,blocked_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        taskId,
        ownerId,
        owner.name,
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
      await client.query<{ card_type: string; ran: boolean }>(
        `SELECT c.card_type,EXISTS(SELECT 1 FROM agent_brainstorms b
           WHERE b.task_id=c.task_id AND b.owner_id=c.owner_id AND b.completed_at IS NOT NULL) AS ran
         FROM agent_cards c WHERE c.task_id=$1 AND c.owner_id=$2 FOR NO KEY UPDATE OF c`,
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
    const brainstorm = card.card_type === brainstormCard;
    if (brainstorm && request.question === undefined && !card.ran)
      throw cardRefusal(
        "This brainstorm can't close before its rounds have run. Run them with brainstorm {participants}, then converge to a top 3.",
      );
    const result = cardResult(request, brainstorm);
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
      await pool.query<{ agent: string; card_type: string }>(
        `SELECT c.agent,c.card_type FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND t.session_id=$2`,
        [ownerId, sessionId],
      )
    ).rows[0];
  }

  const agentFor = async (sessionId: string) => (await cardFor(sessionId))?.agent;
  const typeFor = async (sessionId: string) => (await cardFor(sessionId))?.card_type;

  async function askedAgentFor(sessionId: string) {
    return (
      await pool.query<{ to_agent: string }>(
        'SELECT to_agent FROM agent_card_asks WHERE owner_id=$1 AND id=$2',
        [ownerId, sessionId],
      )
    ).rows[0]?.to_agent;
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

  function brainstorm(turn: TurnRef): BrainstormHooks {
    const locked = <T>(work: (client: PoolClient) => Promise<T>) =>
      transaction(async (client) => {
        await lockThread(client);
        return withTurnLock(turn.turnId, () => work(client), client);
      }, pool);
    const session = async (client: PoolClient) => {
      const card = (
        await client.query<{
          task_id: string;
          agent: string;
          card_type: string;
          title: string;
          brief: string;
          done_when: string;
          state: string;
          participants: string[] | null;
          devils_advocate: string | null;
          completed: boolean;
          running: boolean;
        }>(
          `SELECT c.task_id,c.agent,c.card_type,t.title,t.brief,t.done_when,t.state,
             b.participants,b.devils_advocate,b.completed_at IS NOT NULL AS completed,
             EXISTS(SELECT 1 FROM turns r WHERE r.id=b.turn_id AND r.owner_id=b.owner_id
               AND r.status IN ('queued','running','waiting')) AS running
           FROM turns u JOIN agent_cards c ON c.task_id=u.task_id AND c.owner_id=u.owner_id
           JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
           LEFT JOIN agent_brainstorms b ON b.task_id=c.task_id AND b.owner_id=c.owner_id
           WHERE u.id=$1 AND u.owner_id=$2 FOR NO KEY UPDATE OF t`,
          [turn.turnId, ownerId],
        )
      ).rows[0];
      if (!card || card.card_type !== brainstormCard)
        throw cardRefusal(
          `Only a brainstorm card runs brainstorm rounds. Start a card with cardType ${brainstormCard} for one.`,
        );
      if (card.state !== 'open')
        throw cardRefusal('This card is closed, so its brainstorm is over.');
      if (card.completed)
        throw cardRefusal(
          'This brainstorm already ran its rounds, and they run only once. Converge to a top 3 and close the card.',
        );
      return card;
    };
    return {
      begin: async (input) => {
        const registry = await options.registry();
        const resolved = new Map<string, BrainstormParticipant | undefined>();
        for (const name of new Set(input.participants.map((item) => item.trim())))
          resolved.set(name, await options.participant?.(name));
        return locked(async (client) => {
          const card = await session(client);
          if (card.running)
            throw cardRefusal(
              "This brainstorm's rounds are already running. Wait for them, then converge to a top 3.",
            );
          if (!registry || !options.participant)
            throw cardRefusal(
              'Agents are off, so brainstorms are unavailable. Set NOD_AGENTS_ROOT to turn them on.',
            );
          const others = cardOwners(registry)
            .filter((agent) => agent.name !== card.agent)
            .map((agent) => agent.name);
          const names = [...new Set(input.participants.map((name) => name.trim()))];
          if (names.length !== input.participants.length || names.length < 3 || names.length > 5)
            throw cardRefusal(
              `A brainstorm needs 3 to 5 different agents other than you, from: ${others.join(', ')}.`,
            );
          for (const name of names)
            if (!others.includes(name))
              throw cardRefusal(
                name === card.agent
                  ? `${name} owns this card and converges at the end, so pick 3 to 5 other agents from: ${others.join(', ')}.`
                  : `${name} is not an agent that can take part in a brainstorm. Pick from: ${others.join(', ')}.`,
              );
          const devilsAdvocate = input.devilsAdvocate?.trim() ?? names.at(-1)!;
          if (!names.includes(devilsAdvocate))
            throw cardRefusal(
              `The devil's advocate must be one of the participants: ${names.join(', ')}.`,
            );
          const participants = [];
          for (const name of names) {
            const agent = resolved.get(name);
            if (!agent)
              throw cardRefusal(
                `The config for ${name} in agents/ is missing or invalid, so it can't take part. Pick another agent or ask the owner to fix it.`,
              );
            participants.push(agent);
          }
          await client.query(
            `INSERT INTO agent_brainstorms(task_id,owner_id,participants,devils_advocate,turn_id)
             VALUES($1,$2,$3,$4,$5) ON CONFLICT (task_id) DO UPDATE
             SET participants=EXCLUDED.participants,devils_advocate=EXCLUDED.devils_advocate,turn_id=EXCLUDED.turn_id`,
            [card.task_id, ownerId, names, devilsAdvocate, turn.turnId],
          );
          return {
            topic: [card.title, card.brief, `Done when: ${card.done_when}`]
              .filter(Boolean)
              .join('\n'),
            participants,
            devilsAdvocate,
          };
        });
      },
      save: (rounds) =>
        locked(async (client) => {
          const card = await session(client);
          if (!card.participants || !card.devils_advocate)
            throw cardRefusal('This brainstorm has no participants yet. Run brainstorm first.');
          const everyone = [...card.participants].sort().join(',');
          const each = (round: BrainstormRound | undefined, name: BrainstormRound['round']) =>
            round?.round === name &&
            round.entries
              .map((entry) => entry.agent)
              .sort()
              .join(',') === everyone;
          const [ideas, build, devil, ...extra] = rounds;
          if (
            extra.length ||
            !each(ideas, 'ideas') ||
            !each(build, 'build') ||
            devil?.round !== 'devil' ||
            devil.entries.length !== 1 ||
            devil.entries[0]!.agent !== card.devils_advocate
          )
            throw cardRefusal(
              "A brainstorm saves exactly its rounds in order: private ideas and cross-build from every participant, then one devil's advocate.",
            );
          await client.query(
            'UPDATE agent_brainstorms SET rounds=$3,completed_at=now() WHERE task_id=$1 AND owner_id=$2',
            [card.task_id, ownerId, JSON.stringify(rounds)],
          );
        }),
    };
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
        `SELECT c.task_id,c.agent,c.card_type,c.parent_task_id,c.blocked_by,c.estimate_minutes,
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

  return {
    initialize,
    hooks: { start, finish, closed } satisfies CardHooks,
    agentFor,
    typeFor,
    askedAgentFor,
    isCardTurn,
    act,
    brainstorm,
    read,
  };
}
