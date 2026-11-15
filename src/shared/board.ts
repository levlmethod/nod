import type { CardResult } from './cards.ts';

export type BoardState =
  | 'blocked'
  | 'needs_you'
  | 'queued'
  | 'working'
  | 'waiting'
  | 'scheduled'
  | 'failed'
  | 'done'
  | 'stopped';

export type BoardCard = {
  id: string;
  title: string;
  agent: string;
  agentTitle: string;
  team: string;
  client: string;
  cardType: string;
  state: BoardState;
  blockers: { id: string; title: string }[];
  parentId: string | null;
  estimateMinutes: number;
  agentMinutes: number;
  waitingMinutes: number;
  spendUsd: number;
  budgetUsd: number | null;
  flaggedAsks: number;
  updatedAt: string;
  closedAt: string | null;
};

export type BoardTeam = { team: string; title: string; cards: BoardCard[] };

export type BoardClient = {
  client: string;
  title: string;
  spentUsd: number | null;
  capUsd: number | null;
  paused: string | null;
  teams: BoardTeam[];
};

export type Board = { enabled: boolean; recentDays: number; clients: BoardClient[] };

export type BoardCardDetail = {
  card: BoardCard;
  doneWhen: string;
  now: string;
  result: CardResult | null;
  children: { id: string; title: string; agent: string; state: BoardState }[];
  asks: {
    agent: string;
    flagged: boolean;
    exchanges: { question: string; answer: string | null; unanswered: boolean }[];
  }[];
  pmActions: { actor: string; action: string; reason: string; createdAt: string }[];
};
