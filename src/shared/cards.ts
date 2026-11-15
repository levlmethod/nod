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
      top?: Array<{ idea: string; reason: string }>;
    }
  | { question: string };

export const brainstormCard = 'brainstorm';
export const brainstormTop = 3;

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

const pmChild = {
  agent: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200),
  doneWhen: z.string().trim().min(1).max(1000),
  estimateMinutes: z.number().int().positive().max(10_000),
};

export const pmAction = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('nudge'),
      id: z.uuid(),
      message: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      action: z.literal('split'),
      id: z.uuid(),
      cards: z.array(z.object(pmChild).strict()).min(1).max(5),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal('reassign'),
      id: z.uuid(),
      agent: z.string().trim().min(1),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal('decide'),
      ask: z.uuid(),
      decision: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      action: z.literal('escalate'),
      id: z.uuid(),
      question: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);

export type PmAction = z.infer<typeof pmAction>;

export const pmActions = new Set<string>(
  pmAction.options.map((option) => option.shape.action.value),
);

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
  Type.Object(
    {
      action: Type.Literal('nudge'),
      id: uuid,
      message: Type.String({ minLength: 1, maxLength: 4000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('split'),
      id: uuid,
      cards: Type.Array(
        Type.Object(
          {
            agent: Type.String({ minLength: 1 }),
            title: Type.String({ minLength: 1, maxLength: 200 }),
            doneWhen: Type.String({ minLength: 1, maxLength: 1000 }),
            estimateMinutes: Type.Integer({ minimum: 1, maximum: 10_000 }),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 5 },
      ),
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('reassign'),
      id: uuid,
      agent: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('decide'),
      ask: uuid,
      decision: Type.String({ minLength: 1, maxLength: 4000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('escalate'),
      id: uuid,
      question: Type.String({ minLength: 1, maxLength: 2000 }),
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
  activity: { actor: string; action: string; detail: string; at: string }[];
};

export const cardFinishParams = {
  card: Type.Optional(
    Type.Object({
      conclusion: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Array(Type.String())),
      nextAction: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.String()),
      top: Type.Optional(
        Type.Array(
          Type.Object({
            idea: Type.Optional(Type.String()),
            reason: Type.Optional(Type.String()),
          }),
        ),
      ),
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

export function cardResult(
  input: { card?: unknown; question?: unknown },
  brainstorm = false,
): CardResult {
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
  const result = {
    conclusion: text(card.conclusion),
    evidence,
    nextAction: text(card.nextAction),
    confidence: confidence as (typeof cardConfidence)[number],
  };
  if (!brainstorm) {
    if (card.top !== undefined)
      throw cardRefusal(
        `Only a brainstorm card closes with top. Remove top from the result. ${closeHint}`,
      );
    return result;
  }
  const top = (Array.isArray(card.top) ? card.top : []).map((item) => {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<
      string,
      unknown
    >;
    return { idea: text(entry.idea), reason: text(entry.reason) };
  });
  if (top.length !== brainstormTop || top.some((item) => !item.idea || !item.reason))
    throw cardRefusal(
      `This brainstorm can't close: top must be exactly ${brainstormTop} ideas, best first, each with idea and reason. ${closeHint}`,
    );
  return { ...result, top };
}

export function cardResultText(result: CardResult) {
  if ('question' in result) return result.question;
  const top = result.top
    ? `Top ${result.top.length}:\n${result.top.map((item, index) => `${index + 1}. ${item.idea}: ${item.reason}`).join('\n')}\n\n`
    : '';
  return `${top}${result.conclusion}\n\nEvidence:\n${result.evidence.map((item) => `- ${item}`).join('\n')}\n\nNext action: ${result.nextAction}\nConfidence: ${result.confidence}`;
}
