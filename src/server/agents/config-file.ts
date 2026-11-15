import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { parse } from 'yaml';

export function configFile<T>(schema: TSchema, text: string): { fields: T; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error('The file has no frontmatter block between --- lines.');
  const fields = (parse(match[1]) ?? {}) as unknown;
  if (!Value.Check(schema, fields)) {
    const error = Value.Errors(schema, fields).First();
    throw new Error(`${error?.path || 'frontmatter'}: ${error?.message ?? 'is invalid'}.`);
  }
  return { fields: fields as T, body: match[2].trim() };
}
