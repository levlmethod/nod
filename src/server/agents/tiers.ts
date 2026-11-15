import type { AgentConfig } from './registry.ts';
import type { ClientConfig } from './clients.ts';

export type ActionTier = { tier: 1 | 2; reason: string };

const reads = new Set([
  'get',
  'list',
  'search',
  'read',
  'query',
  'find',
  'fetch',
  'count',
  'describe',
  'retrieve',
  'lookup',
  'research',
  'insights',
  'metadata',
  'download',
]);
const outward = new Map([
  ...['send', 'reply', 'forward', 'invite', 'share'].map(
    (word) => [word, 'sends to people outside the agency'] as const,
  ),
  ...['publish', 'post', 'tweet', 'unpublish'].map((word) => [word, 'publishes'] as const),
  ...['delete', 'remove', 'trash', 'destroy', 'purge', 'erase'].map(
    (word) => [word, 'deletes'] as const,
  ),
  ...['refund', 'charge', 'pay', 'payout', 'transfer', 'purchase', 'buy', 'subscribe'].map(
    (word) => [word, 'moves money'] as const,
  ),
  ...[
    'budget',
    'budgets',
    'bid',
    'bids',
    'boost',
    'launch',
    'activate',
    'enable',
    'resume',
    'unpause',
    'increase',
    'raise',
    'scale',
  ].map((word) => [word, 'can raise spend'] as const),
]);
const reductions = new Set(['pause', 'stop', 'disable', 'deactivate']);
const statusKeys = new Set([
  'status',
  'state',
  'effectivestatus',
  'configuredstatus',
  'isactive',
  'active',
  'enabled',
]);
const on = /^(active|enabled?|on|live|running|resumed?|unpaused)$/i;
const off = /^(paused|inactive|disabled?|off|archived|stopped)$/i;
const gone = /^(deleted|removed|trashed)$/i;

function words(action: string) {
  return action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const key = (name: string) => name.toLowerCase().replace(/[^a-z]/g, '');
const amount = (value: unknown) =>
  typeof value === 'number' || (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value));

export function actionTier(action: string, args: Record<string, unknown>): ActionTier | undefined {
  if (action.startsWith('NOD_')) return undefined;
  const entries = Object.entries(args);
  if (
    entries.some(([name, value]) => /budget|bid/i.test(name) && !/id$/i.test(name) && amount(value))
  )
    return {
      tier: 2,
      reason: 'It changes a budget or bid, and Nod cannot tell whether that lowers spend.',
    };
  let reduces = false;
  for (const [name, value] of entries) {
    if (!statusKeys.has(key(name))) continue;
    if (value === true || (typeof value === 'string' && on.test(value.trim())))
      return { tier: 2, reason: 'It turns something on, which can raise spend.' };
    if (typeof value === 'string' && gone.test(value.trim()))
      return { tier: 2, reason: 'It deletes something.' };
    if (value === false || (typeof value === 'string' && off.test(value.trim()))) reduces = true;
  }
  const tokens = words(action);
  const read = tokens.some((token) => reads.has(token));
  const risk = read ? undefined : tokens.map((token) => outward.get(token)).find(Boolean);
  if (risk) return { tier: 2, reason: `It ${risk}.` };
  if (reduces || tokens.some((token) => reductions.has(token)))
    return { tier: 1, reason: 'It only reduces spend.' };
  if (read) return { tier: 1, reason: 'It only reads.' };
  if (tokens.includes('draft')) return { tier: 1, reason: 'It only prepares a draft.' };
  return undefined;
}

export function tierRules(
  agent: Pick<AgentConfig, 'name' | 'title'>,
  client: Pick<ClientConfig, 'name' | 'title' | 'connections'>,
) {
  const accounts = (client.connections ?? [])
    .map(({ service, account }) => `${service} ${account}`)
    .join(', ');
  const where = accounts
    ? `${client.title}'s accounts (${accounts})`
    : `${client.title}'s accounts`;
  return [
    `Agent tier rules for the ${agent.title} agent working on a ${client.title} card:`,
    `- Go ahead without asking: reading and researching, including ${where} and public websites; preparing drafts that are not sent or published; and actions that only reduce ${client.title}'s ad spend on ${where}, such as pausing an ad, ad set or campaign.`,
    `- Ask me first before any action that raises spend or might (a budget or bid change, launching, resuming or turning on ads, buying or paying for anything), publishes or posts anything, sends or replies to anyone, or deletes anything.`,
  ].join('\n');
}
