import { Type } from '@sinclair/typebox';
import { z } from 'zod';

const uuid = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});

export const cardConfidence = ['low', 'medium', 'high'] as const;

export type CardResult =
  | {
      conclusion: string;
      evidence: string[];
      nextAction: string;
      confidence: (typeof cardConfidence)[number];
    }
  | { question: string };

export const cardStartFields = {
  agent: z.string().trim().min(1).optional(),
  client: z.string().trim().min(1).optional(),
  cardType: z.string().trim().min(1).max(60).optional(),
  estimateMinutes: z.number().int().positive().max(10_000).optional(),
  blockedBy: z.array(z.uuid()).max(20).optional(),
};

export const cardFinishFields = {
  card: z.unknown().optional(),
  question: z.string().optional(),
};

export const cardStartParams = {
  agent: Type.Optional(Type.String({ minLength: 1 })),
  client: Type.Optional(Type.String({ minLength: 1 })),
  cardType: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  estimateMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  blockedBy: Type.Optional(Type.Array(uuid, { maxItems: 20 })),
};

export const askLimit = 3;

export const cardAsk = z
  .object({
    action: z.literal('ask'),
    id: z.uuid(),
    agent: z.string().trim().min(1),
    question: z.string().trim().min(1).max(4000),
  })
  .strict();

export const cardAnswer = z
  .object({ action: z.literal('answer'), id: z.uuid(), answer: z.string().trim().min(1).max(4000) })
  .strict();

export const cardActionParams = [
  Type.Object(
    {
      action: Type.Literal('ask'),
      id: uuid,
      agent: Type.String({ minLength: 1 }),
      question: Type.String({ minLength: 1, maxLength: 4000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('answer'),
      id: uuid,
      answer: Type.String({ minLength: 1, maxLength: 4000 }),
    },
    { additionalProperties: false },
  ),
] as const;

export type CardView = {
  taskId: string;
  agent: string;
  client: string | null;
  budgetUsd: number | null;
  cardType: string;
  parentTaskId: string | null;
  blockedBy: string[];
  openBlockers: string[];
  estimateMinutes: number;
  agentMinutes: number;
  waitingMinutes: number;
  asks: { id: string; agent: string; exchanges: number; pending: boolean; flagged: boolean }[];
};

export const cardFinishParams = {
  card: Type.Optional(
    Type.Object({
      conclusion: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Array(Type.String())),
      nextAction: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.String()),
    }),
  ),
  question: Type.Optional(Type.String()),
};

const closeHint =
  'Close a card with card {conclusion, evidence: [...], nextAction, confidence: low|medium|high}, or with question set to exactly one question for the owner.';

export function cardRefusal(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export function cardResult(input: { card?: unknown; question?: unknown }): CardResult {
  const hasCard = input.card !== undefined;
  const hasQuestion = input.question !== undefined;
  if (hasCard && hasQuestion)
    throw cardRefusal(`This card can't close with both a result and a question. ${closeHint}`);
  if (hasQuestion) {
    const question = text(input.question);
    const marks = question.match(/[?？]/gu)?.length ?? 0;
    if (!question || marks !== 1 || !/[?？]$/u.test(question))
      throw cardRefusal(
        `This card can't close: question must be exactly one question for the owner, ending in its only question mark. ${closeHint}`,
      );
    return { question };
  }
  const card = (typeof input.card === 'object' && input.card !== null ? input.card : {}) as Record<
    string,
    unknown
  >;
  const evidence = Array.isArray(card.evidence) ? card.evidence.map(text) : [];
  const confidence = text(card.confidence).toLowerCase();
  const missing = [
    ...(text(card.conclusion) ? [] : ['conclusion']),
    ...(evidence.length && evidence.every(Boolean) ? [] : ['evidence']),
    ...(text(card.nextAction) ? [] : ['nextAction']),
    ...((cardConfidence as readonly string[]).includes(confidence) ? [] : ['confidence']),
  ];
  if (missing.length)
    throw cardRefusal(
      `This card can't close: the result is missing ${missing.join(', ')}. ${closeHint}`,
    );
  return {
    conclusion: text(card.conclusion),
    evidence,
    nextAction: text(card.nextAction),
    confidence: confidence as (typeof cardConfidence)[number],
  };
}

export function cardResultText(result: CardResult) {
  if ('question' in result) return result.question;
  return `${result.conclusion}\n\nEvidence:\n${result.evidence.map((item) => `- ${item}`).join('\n')}\n\nNext action: ${result.nextAction}\nConfidence: ${result.confidence}`;
}
