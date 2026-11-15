import { Type } from '@sinclair/typebox';
import { z } from 'zod';

const reason = z.string().trim().min(1).max(500);

export const approvalNoteFields = {
  approval: z
    .object({ why: reason, ifWaiting: reason, urgent: reason.optional() })
    .strict()
    .optional(),
};

const text = Type.String({ minLength: 1, maxLength: 500 });

export const approvalNoteParams = {
  approval: Type.Optional(
    Type.Object(
      { why: text, ifWaiting: text, urgent: Type.Optional(text) },
      { additionalProperties: false },
    ),
  ),
};

export type ApprovalNote = { why: string; ifWaiting: string; urgent?: string };
