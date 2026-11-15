import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { Board, BoardCard } from '../../shared/board.ts';
import type { CardResult } from '../../shared/cards.ts';
import { logFailure } from '../failure-log.ts';
import { activeThread, lockThread } from '../thread.ts';
import { transaction } from '../transaction.ts';
import type { WorkConsumers } from '../work-admission.ts';
import { chiefOfStaffAgent, type AgentRegistry } from './registry.ts';
import type { TierQueueItem } from './tier-queue.ts';

export const digestTimeZone = 'America/New_York';
const digestQueue = 'agent-chief-of-staff-digest';
const digestCron = '0 7 * * *';

type CardLine = { id: string; title: string; client: string; agent: string };

export type Digest = {
  since: Date;
  decisions: Array<TierQueueItem & { question: string }>;
  escalations: Array<CardLine & { question: string; at: Date }>;
  finished: Array<CardLine & { conclusion: string; nextAction: string }>;
  stuck: Array<CardLine & { state: BoardCard['state']; reason: string }>;
  anomalies: Array<
    CardLine & { summary: string; latest: number; baseline: number | null; open: boolean }
  >;
  spend: Array<{
    client: string;
    title: string;
    spentUsd: number;
    capUsd: number;
    paused: string | null;
  }>;
};

const dollars = (value: number) => `$${value.toFixed(2)}`;

function stuckReason(card: BoardCard, result: CardResult | null) {
  if (card.state === 'blocked')
    return `Waiting on ${card.blockers.map((blocker) => blocker.title).join(', ')}.`;
  if (card.state === 'failed') return 'Its last run failed.';
  if (result && 'question' in result) return `Closed with a question for you: ${result.question}`;
  return 'Waiting on your answer on the card.';
}

export function digestMessages(digest: Digest, agentTitle: string) {
  const { decisions } = digest;
  const intro = [
    `**Morning digest from the ${agentTitle}**`,
    decisions.length
      ? `${decisions.length === 1 ? '1 decision needs' : `${decisions.length} decisions need`} you. Use reply on each decision below and answer yes or no. Only a reply to a decision answers it.`
      : 'No decisions are waiting on you.',
  ].join('\n\n');
  const asks = decisions.map((item, index) =>
    [
      `**Decision ${index + 1} of ${decisions.length}: ${item.clientTitle}, ${item.agentTitle}**`,
      item.question,
      `Card: ${item.card}`,
      `Why: ${item.why}`,
      `If you wait: ${item.ifWaiting}`,
      ...(item.urgent ? [`Urgent: ${item.urgent}`] : []),
      'Reply to this message with yes to approve or no to decline.',
    ].join('\n'),
  );
  const section = (title: string, lines: string[]) =>
    lines.length ? [`**${title}**\n${lines.map((line) => `- ${line}`).join('\n')}`] : [];
  const report = [
    ...section(
      'Escalated by the PM',
      digest.escalations.map(
        (item) => `${item.client}: ${item.title} (${item.agent}). ${item.question}`,
      ),
    ),
    ...section(
      'Finished',
      digest.finished.map(
        (item) =>
          `${item.client}: ${item.title} (${item.agent}). ${item.conclusion} Next: ${item.nextAction}`,
      ),
    ),
    ...section(
      'Blocked or waiting on you',
      digest.stuck.map((item) => `${item.client}: ${item.title} (${item.agent}). ${item.reason}`),
    ),
    ...section(
      'Anomalies found',
      digest.anomalies.map(
        (item) =>
          `${item.client}: ${item.summary} ${item.open ? `Investigating in "${item.title}" (${item.agent}).` : `"${item.title}" is closed.`}`,
      ),
    ),
    ...section(
      'Spend this month',
      digest.spend.map(
        (client) =>
          `${client.title}: ${dollars(client.spentUsd)} of ${dollars(client.capUsd)}${client.paused ? `. Paused: ${client.paused}` : ''}`,
      ),
    ),
  ];
  return [
    intro,
    ...asks,
    report.length ? report.join('\n\n') : 'Nothing else happened since the last digest.',
  ];
}

export function createDigest(options: {
  pool: Pool;
  ownerId: string;
  registry: () => Promise<AgentRegistry | undefined>;
  board: { read(): Promise<Board> };
  queue: { list(): Promise<TierQueueItem[]> };
  refresh?: () => void;
}) {
  const { pool, ownerId } = options;

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_digests (
        owner_id text NOT NULL,
        day text NOT NULL,
        message_ids uuid[] NOT NULL DEFAULT '{}',
        posted_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, day)
      );
    `);
  }

  async function exists(table: string) {
    return Boolean((await pool.query('SELECT to_regclass($1) AS name', [table])).rows[0]?.name);
  }

  async function collect(since: Date): Promise<Digest> {
    const [board, queued] = await Promise.all([options.board.read(), options.queue.list()]);
    const cards = board.clients.flatMap((client) =>
      client.teams.flatMap((team) =>
        team.cards.map((card) => ({ card, clientTitle: client.title })),
      ),
    );
    const line = ({ card, clientTitle }: (typeof cards)[number]): CardLine => ({
      id: card.id,
      title: card.title,
      client: clientTitle,
      agent: card.agentTitle,
    });
    const thread = await activeThread(pool, ownerId);
    const questions = new Map(
      (
        await pool.query<{ id: string; text: string }>(
          `SELECT id,text FROM messages WHERE owner_id=$1 AND id=ANY($2::uuid[])
           AND thread_id=$3 AND hidden_at IS NULL`,
          [ownerId, queued.map((item) => item.messageId), thread.id],
        )
      ).rows.map((row) => [row.id, row.text]),
    );
    const decisions = queued.flatMap((item) => {
      const question = questions.get(item.messageId);
      return question === undefined ? [] : [{ ...item, question }];
    });
    const escalations = (
      await pool.query<{ task_id: string; detail: string; created_at: Date }>(
        `SELECT v.task_id,v.detail,v.created_at FROM agent_card_activity v
         WHERE v.owner_id=$1 AND v.actor='pm' AND v.action='escalate' AND v.created_at>=$2
         ORDER BY v.created_at,v.id`,
        [ownerId, since],
      )
    ).rows;
    const results = new Map(
      (
        await pool.query<{ task_id: string; result: CardResult | null }>(
          'SELECT task_id,result FROM agent_cards WHERE owner_id=$1 AND task_id=ANY($2::uuid[])',
          [ownerId, cards.map(({ card }) => card.id)],
        )
      ).rows.map((row) => [row.task_id, row.result]),
    );
    const byId = new Map(cards.map((entry) => [entry.card.id, entry]));
    const waiting = new Set(decisions.map((item) => item.taskId));
    const escalated = new Set(escalations.map((row) => row.task_id));
    const anomalies = (await exists('watcher_cards'))
      ? (
          await pool.query<{
            task_id: string;
            summary: string;
            latest: number;
            baseline: number | null;
          }>(
            `SELECT task_id,summary,latest,baseline FROM watcher_cards
             WHERE owner_id=$1 AND opened_at>=$2 ORDER BY opened_at,task_id`,
            [ownerId, since],
          )
        ).rows
      : [];
    const finished = cards.flatMap((entry) => {
      const result = results.get(entry.card.id);
      return entry.card.state === 'done' &&
        entry.card.closedAt &&
        Date.parse(entry.card.closedAt) >= since.getTime() &&
        result &&
        'conclusion' in result
        ? [{ ...line(entry), conclusion: result.conclusion, nextAction: result.nextAction }]
        : [];
    });
    const stuck = cards.flatMap((entry) =>
      ['blocked', 'needs_you', 'failed'].includes(entry.card.state) &&
      !waiting.has(entry.card.id) &&
      !escalated.has(entry.card.id)
        ? [
            {
              ...line(entry),
              state: entry.card.state,
              reason: stuckReason(entry.card, results.get(entry.card.id) ?? null),
            },
          ]
        : [],
    );
    return {
      since,
      decisions,
      escalations: escalations.flatMap((row) => {
        const entry = byId.get(row.task_id);
        return entry ? [{ ...line(entry), question: row.detail, at: row.created_at }] : [];
      }),
      finished,
      stuck,
      anomalies: anomalies.flatMap((row) => {
        const entry = byId.get(row.task_id);
        return entry
          ? [
              {
                ...line(entry),
                summary: row.summary,
                latest: row.latest,
                baseline: row.baseline,
                open: !['done', 'stopped'].includes(entry.card.state),
              },
            ]
          : [];
      }),
      spend: board.clients
        .filter((client) => client.capUsd !== null)
        .map((client) => ({
          client: client.client,
          title: client.title,
          spentUsd: client.spentUsd ?? 0,
          capUsd: client.capUsd!,
          paused: client.paused,
        })),
    };
  }

  async function chatSource(client: PoolClient) {
    if (!(await exists('channel_inbox'))) return undefined;
    return (
      await client.query<{ source_id: string }>(
        `SELECT source_id FROM channel_inbox WHERE owner_id=$1 AND provider='telegram' AND state='submitted'
         ORDER BY received_at DESC,source_id LIMIT 1`,
        [ownerId],
      )
    ).rows[0]?.source_id;
  }

  async function post(): Promise<
    { posted: true; messageIds: string[]; telegram: boolean } | { posted: false; reason: string }
  > {
    const registry = await options.registry();
    const agent = registry?.agents.get(chiefOfStaffAgent);
    if (!agent)
      return {
        posted: false,
        reason: `No valid Chief of Staff config at agents/core/${chiefOfStaffAgent}.md, so no digest was posted.`,
      };
    const previous = (
      await pool.query<{ posted_at: Date }>(
        'SELECT posted_at FROM agent_digests WHERE owner_id=$1 ORDER BY posted_at DESC LIMIT 1',
        [ownerId],
      )
    ).rows[0]?.posted_at;
    const until = new Date();
    const since = previous ?? new Date(until.getTime() - 24 * 60 * 60_000);
    const digest = await collect(since);
    const texts = digestMessages(digest, agent.title);
    const result = await transaction(async (client) => {
      const day = (
        await client.query<{ day: string }>(
          `INSERT INTO agent_digests(owner_id,day,posted_at) VALUES($1,to_char($3::timestamptz AT TIME ZONE $2,'YYYY-MM-DD'),$3)
           ON CONFLICT DO NOTHING RETURNING day`,
          [ownerId, digestTimeZone, until],
        )
      ).rows[0]?.day;
      if (!day) return undefined;
      const thread = await lockThread(client, ownerId);
      const source = await chatSource(client);
      const replyTo = [null, ...digest.decisions.map((item) => item.messageId), null];
      const ids: string[] = [];
      for (const [index, text] of texts.entries()) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO messages(id,owner_id,role,text,thread_id,reply_to_message_id,created_at)
           VALUES($1,$2,'assistant',$3,$4,$5,clock_timestamp())`,
          [id, ownerId, text, thread.id, replyTo[index] ?? null],
        );
        if (source)
          await client.query('INSERT INTO channel_outbox(message_id,source_id) VALUES($1,$2)', [
            id,
            source,
          ]);
        ids.push(id);
      }
      await client.query('UPDATE agent_digests SET message_ids=$3 WHERE owner_id=$1 AND day=$2', [
        ownerId,
        day,
        ids,
      ]);
      return { messageIds: ids, telegram: Boolean(source) };
    }, pool);
    if (!result) return { posted: false, reason: "Today's digest was already posted." };
    options.refresh?.();
    return { posted: true, ...result };
  }

  async function start(scheduler: { boss: PgBoss; consumers?: WorkConsumers }) {
    const { boss, consumers } = scheduler;
    await boss.createQueue(digestQueue, { retryLimit: 3, retryDelay: 300 });
    await boss.schedule(digestQueue, digestCron, {}, { tz: digestTimeZone });
    const work = () =>
      boss.work(digestQueue, async () => {
        const outcome = await post().catch((error: unknown) => {
          logFailure('agent_digest', error);
          throw error;
        });
        if (!outcome.posted)
          console.error(JSON.stringify({ event: 'agent_digest_skipped', reason: outcome.reason }));
      });
    if (consumers)
      await consumers.register({
        start: work,
        stop: (id) => boss.offWork(digestQueue, { id, wait: true }),
      });
    else await work();
  }

  return { initialize, collect, post, start };
}
