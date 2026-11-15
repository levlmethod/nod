import { createHash } from 'node:crypto';

export type CardSnapshot = {
  taskId: string;
  title: string;
  agent: string;
  estimateMinutes: number;
  agentMinutes: number;
  budgetUsd: number | null;
  spentUsd: number;
  asks: { id: string; agent: string; flagged: boolean }[];
  questions: string[];
  calls: { id: string; name: string; fingerprint: string }[];
  idleSince: string | null;
  handled: string[];
};

export type BoardSnapshot = { now: string; cards: CardSnapshot[] };

export type FlagKind =
  'stalled' | 'repeated_question' | 'ask_over_cap' | 'loop' | 'over_budget' | 'unfinished';

export type Flag = { taskId: string; kind: FlagKind; key: string; detail: string };

export const loopWindow = 12;
const loopRepeats = 4;
const idleMinutes = 15;

export const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);
const normalized = (question: string) =>
  question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const dollars = (value: number) => `$${value.toFixed(2)}`;

function cardFlags(card: CardSnapshot, now: number): Omit<Flag, 'taskId'>[] {
  const flags: Omit<Flag, 'taskId'>[] = [];
  const stalls = Math.floor(card.agentMinutes / (2 * card.estimateMinutes));
  if (stalls >= 1)
    flags.push({
      kind: 'stalled',
      key: `stalled:${stalls}`,
      detail: `Stalled: ${Math.round(card.agentMinutes)} agent minutes against an estimate of ${card.estimateMinutes}.`,
    });
  const asked = new Map<string, { first: string; count: number }>();
  for (const question of card.questions) {
    const key = normalized(question);
    if (!key) continue;
    const seen = asked.get(key);
    asked.set(key, { first: seen?.first ?? question, count: (seen?.count ?? 0) + 1 });
  }
  for (const [key, { first, count }] of asked)
    if (count > 1)
      flags.push({
        kind: 'repeated_question',
        key: `question:${digest(key)}:${count}`,
        detail: `Asked the same question ${count} times: ${first}`,
      });
  for (const ask of card.asks)
    if (ask.flagged)
      flags.push({
        kind: 'ask_over_cap',
        key: `ask:${ask.id}`,
        detail: `The ask with ${ask.agent} (ask ${ask.id}) used its back-and-forths or went unanswered.`,
      });
  const recent = card.calls.slice(-loopWindow);
  const repeats = new Map<string, typeof recent>();
  for (const call of recent)
    repeats.set(call.fingerprint, [...(repeats.get(call.fingerprint) ?? []), call]);
  for (const [fingerprint, calls] of repeats)
    if (calls.length >= loopRepeats)
      flags.push({
        kind: 'loop',
        key: `loop:${digest(fingerprint)}:${calls.at(-1)!.id}`,
        detail: `Looping: called ${calls[0]!.name} ${calls.length} times with the same input in its last ${recent.length} tool calls.`,
      });
  if (card.budgetUsd !== null && card.budgetUsd > 0 && card.spentUsd > card.budgetUsd)
    flags.push({
      kind: 'over_budget',
      key: `over_budget:${Math.floor(card.spentUsd / card.budgetUsd)}`,
      detail: `Over budget: spent ${dollars(card.spentUsd)} of its ${dollars(card.budgetUsd)}.`,
    });
  if (card.idleSince && now - Date.parse(card.idleSince) >= idleMinutes * 60_000)
    flags.push({
      kind: 'unfinished',
      key: `unfinished:${card.idleSince}`,
      detail: `Left open: nothing has run since ${card.idleSince} and the card was never closed with a result or a question.`,
    });
  return flags;
}

export function scanBoard(snapshot: BoardSnapshot): Flag[] {
  const now = Date.parse(snapshot.now);
  return snapshot.cards.flatMap((card) => {
    const handled = new Set(card.handled);
    return cardFlags(card, now)
      .filter((flag) => !handled.has(flag.key))
      .map((flag) => ({ taskId: card.taskId, ...flag }));
  });
}
