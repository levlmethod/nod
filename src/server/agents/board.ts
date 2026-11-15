import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Board, BoardCard, BoardCardDetail, BoardState } from '../../shared/board.ts';
import type { CardResult, CardView } from '../../shared/cards.ts';
import type { Task } from '../../shared/contracts.ts';
import type { AgentRegistry } from './registry.ts';

const recentDays = 7;
const unknownTeam = 'unassigned';

type Spend = { client: string; spentUsd: number; capUsd: number; reason?: string };

function boardState(task: Task, card: CardView, result: CardResult | null): BoardState {
  if (task.status === 'cancelled') return 'stopped';
  if (task.status === 'done') return result && 'question' in result ? 'needs_you' : 'done';
  if (card.openBlockers.length) return 'blocked';
  return task.status;
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
  tasks: () => Promise<Task[]>;
  cards: { read(taskIds?: string[]): Promise<CardView[]> };
  spend: () => Promise<Spend[]>;
}) {
  const { pool, ownerId } = options;

  async function snapshot(ids?: string[]) {
    const [registry, tasks, views] = await Promise.all([
      options.registry(),
      options.tasks(),
      options.cards.read(ids),
    ]);
    const cardIds = views.map((view) => view.taskId);
    const [spent, results] = await Promise.all([
      pool.query<{ task_id: string; spent: number }>(
        `SELECT c.task_id,COALESCE(sum(m.cost_usd::text::numeric),0)::float8 AS spent
         FROM agent_cards c JOIN tasks t ON t.id=c.task_id AND t.owner_id=c.owner_id
         JOIN model_usage m ON m.owner_id=c.owner_id AND (m.session_id=t.session_id OR m.session_id IN (
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
    const titles = new Map(tasks.map((task) => [task.id, task.title]));
    const byId = new Map(tasks.map((task) => [task.id, task]));
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
        updatedAt: task.updatedAt,
        closedAt: task.closedAt,
      });
    }
    return { registry, cards, result };
  }

  async function read(): Promise<Board> {
    const registry = await options.registry();
    if (!registry) return { enabled: false, recentDays, clients: [] };
    const [{ cards }, spend] = await Promise.all([snapshot(), options.spend()]);
    const since = Date.now() - recentDays * 24 * 60 * 60 * 1000;
    const shown = cards
      .filter((card) => !card.closedAt || Date.parse(card.closedAt) >= since)
      .sort(
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
    if (!found) throw Object.assign(new Error('Card not found.'), { statusCode: 404 });
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
        `SELECT actor,action,reason,created_at FROM agent_card_actions
         WHERE owner_id=$1 AND task_id=$2 ORDER BY created_at,id`,
        [ownerId, id],
      ),
    ]);
    const kids = children.rows.length
      ? (await snapshot(children.rows.map((row) => row.task_id))).cards
      : [];
    return {
      card: found,
      doneWhen: task.rows[0]?.done_when ?? '',
      now: task.rows[0]?.now_text ?? '',
      result: result.get(id) ?? null,
      children: kids.map(({ id, title, agent, state }) => ({ id, title, agent, state })),
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
