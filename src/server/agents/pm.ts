import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PgBoss } from 'pg-boss';
import { cardRefusal, pmAction, pmActions } from '../../shared/cards.ts';
import { logFailure } from '../failure-log.ts';
import {
  enqueueTurn,
  insertAssistantMessage,
  lockThread,
  resumeTurn,
  withTurnLock,
  type TurnRef,
} from '../thread.ts';
import { transaction } from '../transaction.ts';
import type { WorkConsumers } from '../work-admission.ts';
import { unsettled, type createCards } from './cards.ts';
import { cardOwners, type AgentRegistry } from './registry.ts';
import { loopWindow, scanBoard, type BoardSnapshot, type Flag } from './pm-scan.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

type Cards = ReturnType<typeof createCards>;

const scanQueue = 'agent-pm-scan';
const live = `('queued','running','waiting')`;

function fingerprint(name: string, input: unknown) {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, stable(item)]),
          )
        : value;
  return `${name}:${digest(JSON.stringify(stable(input) ?? null))}`;
}

export function createPm(options: {
  pool: Pool;
  ownerId: string;
  registry: () => Promise<AgentRegistry | undefined>;
  cards: Cards;
}) {
  const { pool, ownerId, cards } = options;

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_pm_runs (
        id uuid PRIMARY KEY,
        owner_id text NOT NULL,
        flags jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS agent_card_calls (
        id uuid PRIMARY KEY,
        owner_id text NOT NULL,
        task_id uuid NOT NULL REFERENCES tasks(id),
        name text NOT NULL,
        fingerprint text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS agent_card_calls_task ON agent_card_calls(owner_id,task_id,created_at DESC);
    `);
  }

  async function recordCall(turnId: string, name: string, input: unknown) {
    await pool.query(
      `INSERT INTO agent_card_calls(id,owner_id,task_id,name,fingerprint)
       SELECT gen_random_uuid(),$1,c.task_id,$3,$4 FROM turns u
       JOIN tasks t ON t.session_id=u.session_id AND t.owner_id=u.owner_id
       JOIN agent_cards c ON c.task_id=t.id AND c.owner_id=t.owner_id
       WHERE u.id=$2 AND u.owner_id=$1`,
      [ownerId, turnId, name, fingerprint(name, input)],
    );
  }

  async function snapshot(): Promise<BoardSnapshot> {
    const rows = (
      await pool.query(
        `SELECT c.task_id,t.title,c.agent,c.estimate_minutes,c.budget_usd,
           COALESCE((SELECT sum(m.cost_usd) FROM model_usage m JOIN turns u ON u.id=m.turn_id
             WHERE u.owner_id=c.owner_id AND (u.session_id=t.session_id
               OR u.session_id IN (SELECT a.id FROM agent_card_asks a WHERE a.owner_id=c.owner_id AND a.task_id=c.task_id))),0) AS spent,
           ARRAY(SELECT x->>'question' FROM agent_card_asks a CROSS JOIN LATERAL jsonb_array_elements(a.exchanges) x
             WHERE a.owner_id=c.owner_id AND a.task_id=c.task_id ORDER BY a.created_at) AS asked,
           ARRAY(SELECT (SELECT m.text FROM messages m WHERE m.owner_id=u.owner_id AND m.turn_id=u.id AND m.role='assistant'
               ORDER BY m.created_at DESC,m.id DESC LIMIT 1)
             FROM turns u WHERE u.owner_id=c.owner_id AND u.session_id=t.session_id
               AND EXISTS(SELECT 1 FROM turn_events e WHERE e.turn_id=u.id AND e.type='waiting')
             ORDER BY u.created_at,u.id) AS owner_questions,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id',k.id,'name',k.name,'fingerprint',k.fingerprint) ORDER BY k.created_at,k.id)
             FROM (SELECT * FROM agent_card_calls k WHERE k.owner_id=c.owner_id AND k.task_id=c.task_id
               ORDER BY k.created_at DESC,k.id DESC LIMIT ${loopWindow}) k),'[]') AS calls,
           CASE WHEN NOT EXISTS(SELECT 1 FROM turns u WHERE u.owner_id=c.owner_id AND u.session_id=t.session_id AND u.status IN ${live})
             AND NOT EXISTS(SELECT 1 FROM agent_cards k JOIN tasks kt ON kt.id=k.task_id AND kt.owner_id=k.owner_id
               WHERE k.owner_id=c.owner_id AND k.parent_task_id=c.task_id AND ${unsettled('kt')})
             AND NOT EXISTS(SELECT 1 FROM agent_card_asks a JOIN turns u ON u.session_id=a.id AND u.owner_id=a.owner_id
               WHERE a.owner_id=c.owner_id AND a.task_id=c.task_id AND u.status IN ${live})
             AND (t.next_check IS NULL OR t.next_check<=now())
           THEN (SELECT max(u.finished_at) FROM turns u WHERE u.owner_id=c.owner_id AND u.session_id=t.session_id) END AS idle_since,
           ARRAY(SELECT v.flag_key FROM agent_card_activity v
             WHERE v.owner_id=c.owner_id AND v.task_id=c.task_id AND v.flag_key IS NOT NULL) AS handled
         FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND t.state='open'
         ORDER BY c.created_at,c.task_id`,
        [ownerId],
      )
    ).rows;
    const views = new Map(
      (await cards.read(rows.map((row) => row.task_id))).map((view) => [view.taskId, view]),
    );
    return {
      now: new Date().toISOString(),
      cards: rows.map((row) => {
        const view = views.get(row.task_id)!;
        return {
          taskId: row.task_id,
          title: row.title,
          agent: row.agent,
          estimateMinutes: row.estimate_minutes,
          agentMinutes: view.agentMinutes,
          budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
          spentUsd: Number(row.spent),
          asks: view.asks.map(({ id, agent, flagged }) => ({ id, agent, flagged })),
          questions: [...row.asked, ...row.owner_questions].filter(
            (question): question is string => typeof question === 'string',
          ),
          calls: row.calls,
          idleSince: row.idle_since ? (row.idle_since as Date).toISOString() : null,
          handled: row.handled,
        };
      }),
    };
  }

  function brief(board: BoardSnapshot, flags: Flag[]) {
    const flagged = board.cards.filter((card) => flags.some((flag) => flag.taskId === card.taskId));
    return `The board scan flagged these cards. Deal with each one using your card actions, then end your turn.\n\n${flagged
      .map((card) =>
        [
          `Card ${card.taskId} "${card.title}", owned by ${card.agent}: ${Math.round(card.agentMinutes)} of ${card.estimateMinutes} estimated agent minutes, spent $${card.spentUsd.toFixed(2)}${card.budgetUsd === null ? '' : ` of $${card.budgetUsd.toFixed(2)}`}.`,
          ...flags.filter((flag) => flag.taskId === card.taskId).map((flag) => `- ${flag.detail}`),
          ...card.asks.map(
            (ask) => `- Ask ${ask.id} with ${ask.agent}${ask.flagged ? ' (flagged)' : ''}.`,
          ),
        ].join('\n'),
      )
      .join('\n\n')}`;
  }

  async function scan() {
    if (!(await options.registry())) return { flags: [] as Flag[] };
    const running = async (client: Pool | PoolClient) =>
      Boolean(
        (
          await client.query(
            `SELECT 1 FROM agent_pm_runs r JOIN turns u ON u.session_id=r.id AND u.owner_id=r.owner_id
             WHERE r.owner_id=$1 AND u.status IN ${live} LIMIT 1`,
            [ownerId],
          )
        ).rowCount,
      );
    if (await running(pool)) return { flags: [] as Flag[] };
    const board = await snapshot();
    const flags = scanBoard(board);
    if (!flags.length) return { flags };
    const runId = randomUUID();
    const started = await transaction(async (client) => {
      await lockThread(client);
      if (await running(client)) return false;
      await client.query('INSERT INTO agent_pm_runs(id,owner_id,flags) VALUES($1,$2,$3)', [
        runId,
        ownerId,
        JSON.stringify(flags),
      ]);
      const fresh = [];
      for (const flag of flags)
        if (
          await cards.record(client, flag.taskId, {
            actor: 'pm',
            action: 'flagged',
            detail: flag.detail,
            flagKey: flag.key,
          })
        )
          fresh.push(flag);
      if (!fresh.length) return false;
      await enqueueTurn(brief(board, fresh), {
        source: 'task',
        sessionId: runId,
        background: true,
        client,
      });
      return true;
    }, pool);
    return started ? { flags, runId } : { flags: [] as Flag[] };
  }

  async function isPmSession(sessionId: string) {
    return Boolean(
      (
        await pool.query('SELECT 1 FROM agent_pm_runs WHERE owner_id=$1 AND id=$2', [
          ownerId,
          sessionId,
        ])
      ).rowCount,
    );
  }

  async function runOf(client: PoolClient | Pool, turnId: string) {
    return (
      await client.query<{ id: string; flags: Flag[] }>(
        `SELECT r.id,r.flags FROM agent_pm_runs r JOIN turns u ON u.session_id=r.id AND u.owner_id=r.owner_id
         WHERE r.owner_id=$1 AND u.id=$2`,
        [ownerId, turnId],
      )
    ).rows[0];
  }

  async function act(turn: TurnRef, raw: unknown) {
    const action = String((raw as { action?: unknown } | undefined)?.action);
    const run = await runOf(pool, turn.turnId);
    if (!run) {
      if (pmActions.has(action))
        throw cardRefusal(`Only the PM can ${action} a card, from its board check.`);
      return undefined;
    }
    if (action === 'list') return undefined;
    if (!pmActions.has(action))
      throw cardRefusal(
        "The PM only acts on cards: list, nudge, split, reassign, decide or escalate. It can't do a card's work.",
      );
    const request = pmAction.parse(raw);
    const registry = await options.registry();
    if (!registry)
      throw cardRefusal('Agents are off, so the PM has nothing to act on. Set NOD_AGENTS_ROOT.');
    const owners = cardOwners(registry);
    const ownerNames = owners.map((agent) => agent.name).join(', ');
    return transaction(async (client) => {
      await lockThread(client);
      return withTurnLock(
        turn.turnId,
        async () => {
          const ask =
            request.action === 'decide'
              ? (
                  await client.query<{
                    task_id: string;
                    to_agent: string;
                    exchanges: { question: string; answer?: string; unanswered?: boolean }[];
                  }>(
                    'SELECT task_id,to_agent,exchanges FROM agent_card_asks WHERE owner_id=$1 AND id=$2 FOR UPDATE',
                    [ownerId, request.ask],
                  )
                ).rows[0]
              : undefined;
          if (request.action === 'decide' && !ask)
            throw cardRefusal('That ask does not exist. Use an ask ID from the board check.');
          const taskId = request.action === 'decide' ? ask!.task_id : request.id;
          if (!run.flags.some((flag) => flag.taskId === taskId))
            throw cardRefusal(
              'This card was not flagged in this board check, so the PM leaves it alone.',
            );
          const card = (
            await client.query<{ agent: string; title: string; state: string; session_id: string }>(
              `SELECT c.agent,t.title,t.state,t.session_id FROM agent_cards c
               JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
               WHERE c.owner_id=$1 AND c.task_id=$2 FOR NO KEY UPDATE OF c`,
              [ownerId, taskId],
            )
          ).rows[0]!;
          if (card.state !== 'open')
            throw cardRefusal('This card has closed since the board check, so it needs nothing.');
          const held = Boolean(
            (
              await client.query(
                `SELECT 1 FROM turns WHERE owner_id=$1 AND session_id=$2 AND status='queued' AND start_after='infinity'`,
                [ownerId, card.session_id],
              )
            ).rowCount,
          );
          const resume = async (prompt: string) => {
            const latest = await cards.latestTurn(client, card.session_id);
            if (held || !latest) return false;
            await resumeTurn(
              latest,
              `pm:${run.id}:${taskId}:${randomUUID()}`,
              prompt,
              false,
              client,
            );
            return true;
          };
          const record = (detail: string) =>
            cards.record(client, taskId, { actor: 'pm', action: request.action, detail });
          if (request.action === 'nudge') {
            if (held)
              throw cardRefusal(
                'This card is waiting for its blockers, so a nudge would run it too early.',
              );
            await resume(`The PM checked this card and says: ${request.message}`);
            await record(request.message);
            return { nudged: taskId };
          }
          if (request.action === 'split') {
            const unknown = request.cards.filter(
              (child) => !owners.some((agent) => agent.name === child.agent),
            );
            if (unknown.length)
              throw cardRefusal(
                `${unknown.map((child) => child.agent).join(', ')} can't own a card. Use one of: ${ownerNames}.`,
              );
            if (held)
              throw cardRefusal(
                'This card is waiting for its blockers, so it can be split once they close.',
              );
            const plan = request.cards
              .map(
                (child) =>
                  `- ${child.title}: agent ${child.agent}, done when ${child.doneWhen}, ${child.estimateMinutes} agent minutes`,
              )
              .join('\n');
            await resume(
              `The PM split this card: ${request.reason}\nStart each of these as a child card now with task start, naming its agent and estimateMinutes, then wait for their results:\n${plan}`,
            );
            await record(`${request.reason}\n${plan}`);
            return { split: taskId, cards: request.cards.length };
          }
          if (request.action === 'reassign') {
            const next = owners.find((agent) => agent.name === request.agent);
            if (!next || next.name === card.agent)
              throw cardRefusal(
                `Reassign to another agent that can own a card: ${owners
                  .filter((agent) => agent.name !== card.agent)
                  .map((agent) => agent.name)
                  .join(', ')}.`,
              );
            await client.query('UPDATE agent_cards SET agent=$3 WHERE task_id=$1 AND owner_id=$2', [
              taskId,
              ownerId,
              next.name,
            ]);
            await resume(
              `The PM reassigned this card from ${card.agent} to you, ${next.title}: ${request.reason}\nRead what has been done so far, then continue the card.`,
            );
            await record(`From ${card.agent} to ${next.name}: ${request.reason}`);
            return { reassigned: taskId, agent: next.name };
          }
          if (request.action === 'decide') {
            const pending = ask!.exchanges.at(-1);
            const exchanges =
              pending && pending.answer === undefined
                ? [...ask!.exchanges.slice(0, -1), { ...pending, answer: request.decision }]
                : [
                    ...ask!.exchanges,
                    { question: 'The PM made the call.', answer: request.decision },
                  ];
            await client.query(
              'UPDATE agent_card_asks SET exchanges=$3,flagged_at=COALESCE(flagged_at,now()) WHERE id=$1 AND owner_id=$2',
              [request.ask, ownerId, JSON.stringify(exchanges)],
            );
            if (!held)
              await resume(
                `The PM made the call on your ask with ${ask!.to_agent}: ${request.decision}\nTake this as settled, don't ask ${ask!.to_agent} about it again, and carry on.`,
              );
            await record(`On the ask with ${ask!.to_agent}: ${request.decision}`);
            return { decided: request.ask };
          }
          await insertAssistantMessage(
            client,
            turn,
            `The PM needs you on the card "${card.title}" (${card.agent}): ${request.question}`,
          );
          await record(request.question);
          return { escalated: taskId };
        },
        client,
      );
    }, pool);
  }

  async function start(scheduler: { boss: PgBoss; consumers?: WorkConsumers }) {
    const { boss, consumers } = scheduler;
    await boss.createQueue(scanQueue, { retryLimit: 0 });
    await boss.schedule(scanQueue, '*/30 * * * *', {}, { tz: 'UTC' });
    const work = () =>
      boss.work(scanQueue, async () => {
        await scan().catch((error) => logFailure('agent_pm_scan', error));
      });
    if (consumers)
      await consumers.register({
        start: work,
        stop: (id) => boss.offWork(scanQueue, { id, wait: true }),
      });
    else await work();
  }

  return { initialize, recordCall, snapshot, scan, isPmSession, act, start };
}
