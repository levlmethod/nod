import { Type } from '@sinclair/typebox';
import { z } from 'zod';

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
  cardType: z.string().trim().min(1).max(60).optional(),
  estimateMinutes: z.number().int().positive().max(10_000).optional(),
};

export const cardFinishFields = {
  card: z.unknown().optional(),
  question: z.string().optional(),
};

export const cardStartParams = {
  agent: Type.Optional(Type.String({ minLength: 1 })),
  cardType: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  estimateMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
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
