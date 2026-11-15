import { Type, type Static } from '@sinclair/typebox';
import type { DiscoveredTool } from '../../ports/discovered.ts';

const fraction = Type.Number({ exclusiveMinimum: 0 });

export const thresholdSchema = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    source: Type.Object(
      {
        service: Type.String({ minLength: 1 }),
        tool: Type.String({ minLength: 1 }),
        input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        values: Type.String({ minLength: 1 }),
        newestFirst: Type.Optional(Type.Boolean()),
        sortBy: Type.Optional(Type.String({ minLength: 1 })),
        combine: Type.Optional(Type.Union([Type.Literal('sum'), Type.Literal('count')])),
      },
      { additionalProperties: false },
    ),
    drop: Type.Optional(fraction),
    rise: Type.Optional(fraction),
    above: Type.Optional(Type.Number()),
    below: Type.Optional(Type.Number()),
    pace: Type.Optional(
      Type.Object(
        { monthlyUsd: Type.Number({ exclusiveMinimum: 0 }), over: Type.Number({ minimum: 0 }) },
        { additionalProperties: false },
      ),
    ),
    baseline: Type.Optional(Type.Integer({ minimum: 1 })),
    estimateMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  },
  { additionalProperties: false },
);

export const thresholdsSchema = Type.Record(Type.String({ minLength: 1 }), thresholdSchema);

export type Threshold = Static<typeof thresholdSchema>;

const checks = ['drop', 'rise', 'above', 'below', 'pace'] as const;

export function validateThresholds(thresholds: Record<string, Threshold> | undefined) {
  for (const [name, threshold] of Object.entries(thresholds ?? {})) {
    const set = checks.filter((check) => threshold[check] !== undefined);
    if (set.length !== 1)
      throw new Error(
        `thresholds.${name} needs exactly one check of ${checks.join(', ')}, but has ${set.length ? set.join(', ') : 'none'}.`,
      );
  }
}

export type Trip = { latest: number; baseline?: number; summary: string };

const round = (value: number) => Math.round(value * 100) / 100;
const percent = (value: number) => `${Math.round(value * 100)}%`;

function daysInMonth(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' })
    .formatToParts(now)
    .reduce<Record<string, number>>(
      (all, part) => ({ ...all, [part.type]: Number(part.value) }),
      {},
    );
  return new Date(Date.UTC(parts.year!, parts.month!, 0)).getUTCDate();
}

export function checkThreshold(
  threshold: Threshold,
  series: readonly number[],
  at: { now?: Date; timeZone?: string } = {},
): Trip | undefined {
  if (!series.length) throw new Error('The source returned no numbers to check.');
  const latest = series[series.length - 1]!;
  if (threshold.above !== undefined)
    return latest > threshold.above
      ? { latest, summary: `${latest} is above the limit of ${threshold.above}.` }
      : undefined;
  if (threshold.below !== undefined)
    return latest < threshold.below
      ? { latest, summary: `${latest} is below the limit of ${threshold.below}.` }
      : undefined;
  if (threshold.pace) {
    const spent = round(series.reduce((total, value) => total + value, 0));
    const days = daysInMonth(at.now ?? new Date(), at.timeZone ?? 'UTC');
    const expected = (threshold.pace.monthlyUsd * series.length) / days;
    return spent > expected * (1 + threshold.pace.over)
      ? {
          latest: spent,
          baseline: expected,
          summary: `${spent} spent over ${series.length} days is ${percent(spent / expected - 1)} over the pace of ${round(expected)} for a monthly budget of ${threshold.pace.monthlyUsd} (limit: ${percent(threshold.pace.over)} over).`,
        }
      : undefined;
  }
  if (series.length < 2) return undefined;
  const earlier = series.slice(0, -1).slice(-(threshold.baseline ?? 7));
  const baseline = round(earlier.reduce((total, value) => total + value, 0) / earlier.length);
  const window = `its ${earlier.length}-point baseline of ${baseline}`;
  if (threshold.drop !== undefined)
    return baseline > 0 && latest <= baseline * (1 - threshold.drop)
      ? {
          latest,
          baseline,
          summary: `${latest} is down ${percent(1 - latest / baseline)} from ${window} (limit: a ${percent(threshold.drop)} drop).`,
        }
      : undefined;
  if (threshold.rise === undefined) return undefined;
  if (baseline <= 0)
    return latest > 0
      ? {
          latest,
          baseline,
          summary: `${latest} rose from ${window} (limit: a ${percent(threshold.rise)} rise).`,
        }
      : undefined;
  return latest >= baseline * (1 + threshold.rise)
    ? {
        latest,
        baseline,
        summary: `${latest} is up ${percent(latest / baseline - 1)} from ${window} (limit: a ${percent(threshold.rise)} rise).`,
      }
    : undefined;
}

function payload(result: unknown) {
  const value = (result ?? {}) as {
    isError?: unknown;
    structuredContent?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
  const text = (value.content ?? [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('');
  if (value.isError === true) throw new Error(`The source tool failed: ${text.slice(0, 500)}`);
  if (value.structuredContent !== undefined) return value.structuredContent;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `The source tool returned ${text.length} characters that are not JSON and no structured content.`,
    );
  }
}

function pluck(value: unknown, path: string) {
  let current: unknown[] = [value];
  for (const part of path.split('.')) {
    const match = /^([^[\]]*)(?:\[(?:([^=\]]+)=([^\]]*))?\])?$/.exec(part);
    if (!match) throw new Error(`values: ${part} is not a path step.`);
    const [, key, field, wanted] = match;
    const each = part.includes('[');
    current = current.flatMap((item) => {
      const next = key ? (item as Record<string, unknown> | undefined)?.[key] : item;
      if (!each) return [next];
      if (!Array.isArray(next)) return [];
      return field
        ? next.filter((entry) => String((entry as Record<string, unknown>)?.[field]) === wanted)
        : next;
    });
  }
  return current;
}

function sorted(data: unknown, found: unknown[], path: string) {
  const keys = pluck(data, path);
  if (keys.length !== found.length)
    throw new Error(`sortBy ${path} found ${keys.length} keys for ${found.length} values.`);
  const text = keys.map((key, index) => {
    if (typeof key !== 'string' && typeof key !== 'number')
      throw new Error(`sortBy ${path} found no key at position ${index}.`);
    return String(key);
  });
  return found
    .map((value, index) => ({ value, key: text[index]! }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map(({ value }) => value);
}

export function readSeries(result: unknown, source: Threshold['source']) {
  const data = payload(result);
  const plucked = pluck(data, source.values);
  if (source.combine === 'count') return [plucked.length];
  const found = source.sortBy ? sorted(data, plucked, source.sortBy) : plucked;
  const numbers = found.map((item, index) => {
    const number = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN;
    if (!Number.isFinite(number))
      throw new Error(
        `values ${source.values} found ${item === null ? 'null' : Array.isArray(item) ? 'a list' : typeof item} at position ${index}, which is not a number.`,
      );
    return number;
  });
  if (source.combine === 'sum') return [numbers.reduce((total, value) => total + value, 0)];
  return source.newestFirst ? numbers.reverse() : numbers;
}

const readVerbs = new Set(
  'get list read search find count query metadata tables describe fetch lookup'.split(' '),
);
const writeVerbs = new Set(
  'create update delete remove send reply forward archive refund submit post publish write set put patch start retry swap make pay cancel approve label trash mark insert upsert add animate rebuild script exec execute spam flag block sync move copy upload import'.split(
    ' ',
  ),
);
const readNames = [/_run_report$/];

export function writeRefusal(tool: DiscoveredTool | undefined, name: string) {
  if (!tool) return `${name} is not a tool on this connection.`;
  const hints = tool.annotations ?? {};
  const words = name.toLowerCase().split(/[_\-.]+/);
  const write =
    hints.readOnlyHint === false ||
    hints.destructiveHint === true ||
    words.some((word) => writeVerbs.has(word));
  const read =
    words.some((word) => readVerbs.has(word)) || readNames.some((pattern) => pattern.test(name));
  if (!write && read) return undefined;
  return `${name} is not a read-only tool, so a watcher can't call it. Watchers only call a tool whose name is a read, such as get, list, search or query, with no write word in it and no server hint that it writes.`;
}
