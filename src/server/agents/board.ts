import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Board, BoardCard, BoardCardDetail, BoardState } from '../../shared/board.ts';
import type { CardResult, CardView } from '../../shared/cards.ts';
import type { AgentRegistry } from './registry.ts';

const recentDays = 7;
const unknownTeam = 'unassigned';

type Spend = { client: string; spentUsd: number; capUsd: number; reason?: string };

type TaskRow = {
  id: string;
  title: string;
  state: 'open' | 'done' | 'cancelled';
  turn_status: string | null;
  answered: boolean;
  waiting: boolean;
  scheduled: boolean;
  updated_at: Date;
  closed_at: Date | null;
};

function boardState(task: TaskRow, card: CardView, result: CardResult | null): BoardState {
  if (task.state === 'cancelled') return 'stopped';
  if (task.state === 'done') return result && 'question' in result ? 'needs_you' : 'done';
  if (task.turn_status === 'waiting' && !task.answered) return 'needs_you';
  if (card.openBlockers.length) return 'blocked';
  if (task.turn_status === 'queued') return 'queued';
  if (task.turn_status === 'running') return 'working';
  if (task.turn_status === 'failed') return 'failed';
  if (task.waiting) return 'waiting';
  if (task.scheduled) return 'scheduled';
  return 'needs_you';
}

const order: BoardState[] = [
  'needs_you',
  'blocked',
  'failed',
  'working',
  'waiting',
  'queued',
  'scheduled',
  'done',
  'stopped',
];

export function createBoard(options: {
  pool: Pool;
  ownerId: string;
  registry: () => Promise<AgentRegistry | undefined>;
  cards: { read(taskIds?: string[]): Promise<CardView[]> };
  spend: () => Promise<Spend[]>;
}) {
  const { pool, ownerId } = options;

  async function snapshot(ids: string[]) {
    const [registry, views] = await Promise.all([options.registry(), options.cards.read(ids)]);
    const cardIds = views.map((view) => view.taskId);
    const taskIds = [...new Set(views.flatMap((view) => [view.taskId, ...view.openBlockers]))];
    const [tasks, spent, results] = await Promise.all([
      pool.query<TaskRow>(
        `SELECT t.id,t.title,t.state,t.updated_at,t.closed_at,
           COALESCE((SELECT r.status FROM turns r WHERE r.owner_id=t.owner_id AND r.session_id=t.session_id AND r.status='running'),u.status) AS turn_status,
           EXISTS(SELECT 1 FROM turns n WHERE n.owner_id=u.owner_id AND n.thread_id=u.thread_id
             AND n.session_id=u.session_id AND n.parent_turn_id=u.id) AS answered,
           jsonb_array_length(COALESCE(t.waiting_for,'[]'::jsonb))>0 AS waiting,
           t.next_check IS NOT NULL AND t.next_check>now() AS scheduled
         FROM tasks t LEFT JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
         WHERE t.owner_id=$1 AND t.id=ANY($2::uuid[])`,
        [ownerId, taskIds],
      ),
      pool.query<{ task_id: string; spent: number }>(
        `SELECT c.task_id,COALESCE(sum(m.cost_usd::text::numeric),0)::float8 AS spent
         FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         JOIN model_usage m ON m.owner_id=c.owner_id
         LEFT JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
         JOIN LATERAL (SELECT COALESCE(m.session_id,u.session_id) AS id) s ON (s.id=t.session_id OR s.id IN (
           SELECT a.id FROM agent_card_asks a WHERE a.owner_id=c.owner_id AND a.task_id=c.task_id))
         WHERE c.owner_id=$1 AND c.task_id=ANY($2::uuid[]) GROUP BY c.task_id`,
        [ownerId, cardIds],
      ),
      pool.query<{ task_id: string; result: CardResult | null }>(
        'SELECT task_id,result FROM agent_cards WHERE owner_id=$1 AND task_id=ANY($2::uuid[])',
        [ownerId, cardIds],
      ),
    ]);
    const spend = new Map(spent.rows.map((row) => [row.task_id, row.spent]));
    const result = new Map(results.rows.map((row) => [row.task_id, row.result]));
    const titles = new Map(tasks.rows.map((task) => [task.id, task.title]));
    const byId = new Map(tasks.rows.map((task) => [task.id, task]));
    const cards: BoardCard[] = [];
    for (const view of views) {
      const task = byId.get(view.taskId);
      if (!task) continue;
      const agent = registry?.agents.get(view.agent);
      cards.push({
        id: view.taskId,
        title: task.title,
        agent: view.agent,
        agentTitle: agent?.title ?? view.agent,
        team: agent?.team ?? unknownTeam,
        client: view.client ?? '',
        cardType: view.cardType,
        state: boardState(task, view, result.get(view.taskId) ?? null),
        blockers: view.openBlockers.map((id) => ({ id, title: titles.get(id) ?? id })),
        parentId: view.parentTaskId,
        estimateMinutes: view.estimateMinutes,
        agentMinutes: Math.round(view.agentMinutes),
        waitingMinutes: Math.round(view.waitingMinutes),
        spendUsd: spend.get(view.taskId) ?? 0,
        budgetUsd: view.budgetUsd,
        flaggedAsks: view.asks.filter((ask) => ask.flagged).length,
        updatedAt: task.updated_at.toISOString(),
        closedAt: task.closed_at?.toISOString() ?? null,
      });
    }
    return { registry, cards, result };
  }

  async function read(): Promise<Board> {
    const registry = await options.registry();
    if (!registry) return { enabled: false, recentDays, clients: [] };
    const recent = await pool.query<{ task_id: string }>(
      `SELECT c.task_id FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
       WHERE c.owner_id=$1 AND (t.state='open' OR t.closed_at>=now()-make_interval(days=>$2)
         OR (t.state='done' AND c.result ? 'question'))`,
      [ownerId, recentDays],
    );
    const [{ cards }, spend] = await Promise.all([
      snapshot(recent.rows.map((row) => row.task_id)),
      options.spend(),
    ]);
    const shown = cards.sort(
      (a, b) =>
        order.indexOf(a.state) - order.indexOf(b.state) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    const spent = new Map(spend.map((row) => [row.client, row]));
    const clientNames = [
      ...registry.clients.keys(),
      ...new Set(shown.map((card) => card.client).filter((name) => !registry.clients.has(name))),
    ];
    const teamNames = [
      ...registry.teams.keys(),
      ...new Set(shown.map((card) => card.team).filter((name) => !registry.teams.has(name))),
    ];
    return {
      enabled: true,
      recentDays,
      clients: clientNames.map((name) => {
        const config = registry.clients.get(name);
        const budget = spent.get(name);
        return {
          client: name,
          title: config?.title ?? (name || 'No client'),
          spentUsd: budget?.spentUsd ?? null,
          capUsd: budget?.capUsd ?? null,
          paused: budget?.reason ?? null,
          teams: teamNames
            .map((team) => ({
              team,
              title: team === unknownTeam ? 'Unassigned' : team,
              cards: shown.filter((card) => card.client === name && card.team === team),
            }))
            .filter((team) => team.cards.length),
        };
      }),
    };
  }

  async function card(id: string): Promise<BoardCardDetail> {
    const { cards, result } = await snapshot([id]);
    const found = cards[0];
    if (!found)
      throw Object.assign(new Error(`Card ${id} not found for this owner.`), { statusCode: 404 });
    const [task, children, asks, actions] = await Promise.all([
      pool.query<{ done_when: string; now_text: string }>(
        'SELECT done_when,now_text FROM tasks WHERE id=$1 AND owner_id=$2',
        [id, ownerId],
      ),
      pool.query<{ task_id: string }>(
        'SELECT task_id FROM agent_cards WHERE owner_id=$1 AND parent_task_id=$2 ORDER BY created_at,task_id',
        [ownerId, id],
      ),
      pool.query<{
        to_agent: string;
        flagged: boolean;
        exchanges: { question: string; answer?: string; unanswered?: boolean }[];
      }>(
        `SELECT to_agent,flagged_at IS NOT NULL AS flagged,exchanges FROM agent_card_asks
         WHERE owner_id=$1 AND task_id=$2 ORDER BY created_at,id`,
        [ownerId, id],
      ),
      pool.query<{ actor: string; action: string; reason: string; created_at: Date }>(
        `SELECT actor,action,detail AS reason,created_at FROM agent_card_activity
         WHERE owner_id=$1 AND task_id=$2 ORDER BY created_at,id`,
        [ownerId, id],
      ),
    ]);
    const childCards = children.rows.length
      ? (await snapshot(children.rows.map((row) => row.task_id))).cards
      : [];
    return {
      card: found,
      doneWhen: task.rows[0]?.done_when ?? '',
      now: task.rows[0]?.now_text ?? '',
      result: result.get(id) ?? null,
      children: childCards.map(({ id, title, agent, state }) => ({ id, title, agent, state })),
      asks: asks.rows.map((ask) => ({
        agent: ask.to_agent,
        flagged: ask.flagged || ask.exchanges.some((exchange) => exchange.unanswered),
        exchanges: ask.exchanges.map((exchange) => ({
          question: exchange.question,
          answer: exchange.unanswered ? null : (exchange.answer ?? null),
          unanswered: exchange.unanswered === true,
        })),
      })),
      pmActions: actions.rows.map((row) => ({
        actor: row.actor,
        action: row.action,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/board', () => read());
    app.get<{ Params: { id: string } }>('/api/board/cards/:id', (request) =>
      card(z.uuid().parse(request.params.id)),
    );
  }

  return { read, card, registerRoutes };
}
