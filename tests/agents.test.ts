import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Agent, AgentSessionOptions, AgentTool, RuntimeContext } from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { mcpNamespaces, toolDefinitions } from '../src/runtime/tools.ts';
import {
  bindAgent,
  cardOwners,
  createAgentBinding,
  loadAgentRegistry,
} from '../src/server/agents/registry.ts';
import { loadAgentSkills, rejectMissingSkills } from '../src/server/agents/skills.ts';
import { writeRefusal } from '../src/server/agents/thresholds.ts';
import { wallCard } from '../src/server/agents/clients.ts';
import { scanBoard, type CardSnapshot } from '../src/server/agents/pm-scan.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

const namespaces = (servers: NonNullable<RuntimeContext['mcpServers']>) =>
  mcpNamespaces(servers).map(({ namespace }) => namespace);

async function configRoot(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'nod-agents-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const team = (lead: string) => `---
lead: ${lead}
routing: Routes the owner's requests to the agent that owns the work.
---
`;

const agentFile = (tools: string[], extra = '') => `---
title: Router
role: Routes every request to the right agent's card.
tools: [${tools.join(', ')}]
${extra}---
Route each request to a card for the agent that owns the work. Never do the work yourself.
`;

test('agent and team files load into the registry without code changes', async () => {
  const root = await configRoot({
    'core/team.md': team('router'),
    'core/router.md': agentFile(['task', 'ask_user']),
    'growth/team.md': team('growth-lead'),
    'growth/growth-lead.md': `---
title: Growth Lead
role: Owns growth outcomes for each client.
tools: [task, browser]
skills: [research]
knowledge: []
workflows: []
---
Lead the growth team.
`,
  });
  try {
    const registry = await loadAgentRegistry(root);
    assert.deepEqual(registry.problems, []);
    assert.deepEqual([...registry.teams.keys()].sort(), ['core', 'growth']);
    const lead = registry.agents.get('growth-lead');
    assert.equal(lead?.team, 'growth');
    assert.equal(lead?.title, 'Growth Lead');
    assert.deepEqual(lead?.tools, ['task', 'browser']);
    assert.deepEqual(lead?.skills, ['research']);
    assert.match(lead?.instructions ?? '', /Lead the growth team\./);
    assert.equal(registry.teams.get('growth')?.lead, 'growth-lead');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a broken agent or team file is reported with its path and reason while valid agents load', async () => {
  const root = await configRoot({
    'core/team.md': team('router'),
    'core/router.md': agentFile(['task', 'ask_user']),
    'core/typo.md': agentFile(['task'], 'toolz: [browser]\n'),
    'core/empty.md': 'No frontmatter here.\n',
    'growth/team.md': team('missing-lead'),
    'loose.md': agentFile(['task']),
  });
  try {
    const registry = await loadAgentRegistry(root);
    assert.ok(registry.agents.has('router'));
    assert.ok(!registry.agents.has('typo'));
    assert.ok(!registry.agents.has('empty'));
    const byPath = new Map(registry.problems.map((problem) => [problem.path, problem.reason]));
    assert.match(byPath.get('core/typo.md') ?? '', /toolz/);
    assert.match(byPath.get('core/empty.md') ?? '', /frontmatter/i);
    assert.match(byPath.get('growth/team.md') ?? '', /missing-lead/);
    assert.match(byPath.get('loose.md') ?? '', /team folder/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an agent naming a tool that does not exist is rejected with the name', async () => {
  const root = await configRoot({
    'core/team.md': team('router'),
    'core/router.md': agentFile(['task', 'ask_user']),
    'core/helper.md': agentFile(['task', 'browse']),
  });
  try {
    const registry = await loadAgentRegistry(root, ['task', 'ask_user', 'browser']);
    assert.ok(registry.agents.has('router'));
    assert.ok(!registry.agents.has('helper'));
    assert.match(registry.problems[0]?.reason ?? '', /browse/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing config root loads as an empty registry with one problem', async () => {
  const registry = await loadAgentRegistry(join(tmpdir(), `nod-agents-missing-${randomUUID()}`));
  assert.equal(registry.agents.size, 0);
  assert.equal(registry.problems.length, 1);
});

test('the main chat runs as the Router, falls back to a routing-only Router when its config is broken, and task and background sessions run unbound', async () => {
  const root = await configRoot({
    'core/team.md': team('router'),
    'core/router.md': agentFile(['task', 'ask_user', 'send_message']),
  });
  try {
    const registry = await loadAgentRegistry(root);
    const threadId = randomUUID();
    const chat = bindAgent(registry, { threadId, sessionId: threadId });
    assert.equal(chat.agent?.name, 'router');
    assert.deepEqual(chat.agent?.tools, ['task', 'ask_user', 'send_message']);
    assert.equal(bindAgent(registry, { threadId, sessionId: randomUUID() }).agent, undefined);
    assert.equal(
      bindAgent(registry, {
        threadId,
        sessionId: threadId,
        proactivity: {} as RuntimeContext['proactivity'],
      }).agent,
      undefined,
    );
    const fallback = bindAgent(await loadAgentRegistry(join(root, 'nowhere')), {
      threadId,
      sessionId: threadId,
    }).agent;
    assert.equal(fallback?.name, 'router');
    assert.ok(
      fallback && !fallback.tools.some((tool) => ['browser', 'apps', 'delegate'].includes(tool)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('without NOD_AGENTS_ROOT the main chat runs unbound, as upstream Nod does', async () => {
  const threadId = randomUUID();
  const binding = createAgentBinding({
    knownTools: ['task'],
    namespaces,
    card: async () => ({
      agent: 'growth-analyst',
      client: 'rkmd',
      role: 'owner' as const,
      card_type: null,
    }),
    wallRecords: async () => ({ sessionTurns: new Set(), clientCards: new Set() }),
    root: '',
  });
  assert.deepEqual(await binding.bind({ threadId, sessionId: threadId }), {});
  assert.deepEqual(await binding.bind({ threadId, sessionId: randomUUID() }), {});
  assert.equal(await binding.registry(), undefined);
});

async function runAs(
  agent: RuntimeContext['agent'],
  run: (tools: Map<string, AgentTool>, options: AgentSessionOptions) => Promise<void>,
  extra: Partial<RuntimeContext> = {},
  prepareMemory?: () => Promise<undefined>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'nod-agent-session-'));
  const threadId = randomUUID();
  const context: RuntimeContext = {
    threadId,
    sessionId: threadId,
    turnId: randomUUID(),
    prompt: 'Find out why RKMD conversions dropped',
    history: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async () => {},
    reply: async () => {},
    delta: () => {},
    publish: async () => {
      throw new Error('Not used');
    },
    requestCredential: async () => ({ url: '/credentials/fixture' }),
    integration: async () => ({}),
    manage: async () => ({}),
    ...(agent ? { agent } : {}),
    ...extra,
  };
  const session: Agent = {
    open: async (options) => ({
      resumed: false,
      prompt: async () => run(new Map(options.tools.map((tool) => [tool.name, tool])), options),
      abort: () => {},
      dispose: () => {},
    }),
    dispose: () => {},
  };
  const runtime = createAgentRuntime({
    agent: session,
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
    ...(prepareMemory ? { prepareMemory } : {}),
  });
  try {
    await runtime.runTurn(context);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test('the Router gets only its allowed tools and no workspace, web or browser', async () => {
  let checked = false;
  await runAs(
    {
      name: 'router',
      title: 'Router',
      tools: ['task', 'ask_user', 'send_message'],
      instructions: 'Route each request to a card. Never do the work yourself.',
    },
    async (tools, options) => {
      assert.deepEqual([...tools.keys()].sort(), ['ask_user', 'send_message', 'task']);
      assert.equal(options.restricted, true);
      assert.match(options.systemPrompt, /Never do the work yourself\./);
      checked = true;
    },
  );
  assert.ok(checked);
});

test('a session with no agent keeps every upstream tool', async () => {
  let checked = false;
  await runAs(undefined, async (tools, options) => {
    assert.ok(tools.has('browser'));
    assert.ok(tools.has('apps'));
    assert.notEqual(options.restricted, true);
    checked = true;
  });
  assert.ok(checked);
});

const clientFile = (title: string, connections: string, brief: string) => `---
title: ${title}
budget:
  monthlyUsd: 500
connections:
${connections}
dataSources: [ga4]
---
${brief}
`;

const clientConfigs = {
  'clients/rkmd.md': clientFile(
    'RKMD',
    '  - service: googleanalytics\n    account: ads@rkmd.example',
    'RKMD sells clinic services. Its ROAS target is 3.1.',
  ),
  'clients/formulaic.md': clientFile(
    'Formulaic',
    '  - service: googleanalytics\n    account: data@formulaic.example\n  - service: krowdit\n    account: formulaic',
    'Formulaic sells supplements. Its launch is secret until March.',
  ),
};

test('client configs load from the clients folder and a broken one is reported with its reason', async () => {
  const root = await configRoot({
    'core/team.md': team('router'),
    'core/router.md': agentFile(['task', 'ask_user']),
    'growth/team.md': team('growth-lead'),
    'growth/growth-lead.md': agentFile(['task']),
    ...clientConfigs,
    'clients/krowdit.md': `---
title: Krowdit
---
`,
  });
  try {
    const registry = await loadAgentRegistry(root);
    assert.deepEqual([...registry.clients.keys()].sort(), ['formulaic', 'rkmd']);
    assert.equal(registry.clients.get('rkmd')?.budget.monthlyUsd, 500);
    assert.match(registry.clients.get('formulaic')?.brief ?? '', /launch is secret/);
    assert.deepEqual([...registry.teams.keys()].sort(), ['core', 'growth']);
    assert.equal(registry.problems.length, 1);
    assert.match(registry.problems[0]!.path, /clients\/krowdit\.md$/);
    assert.match(registry.problems[0]!.reason, /budget/);
    const chat = bindAgent(registry, { threadId: 't', sessionId: 't' }).agent;
    assert.match(chat?.instructions ?? '', /- rkmd: RKMD/);
    assert.match(chat?.instructions ?? '', /ask the owner which client/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const app = (connectionId: string, account: string) =>
  ({
    slug: 'googleanalytics',
    name: 'Google Analytics',
    status: 'connected',
    connectionId,
    accountEmail: account,
    access: ['api'],
  }) as NonNullable<RuntimeContext['connectedApps']>[number];

const profile = (connectionId: string, label: string) =>
  ({
    slug: 'browser-ads-example',
    name: 'ads.example',
    status: 'connected',
    connectionId,
    accountName: label,
    access: ['browser'],
  }) as NonNullable<RuntimeContext['connectedApps']>[number];

test('a card sees only its own client: other clients’ connections, memory, chat and cards are walled off', async () => {
  const root = await configRoot({
    'core/team.md': team('router'),
    'core/router.md': agentFile(['task']),
    ...clientConfigs,
  });
  try {
    const registry = await loadAgentRegistry(root);
    const rkmdCard = randomUUID();
    const formulaicCard = randomUUID();
    const ownTurn = randomUUID();
    const server = (connectionId: string, accountName: string) => ({
      connectionId,
      pathId: 'p',
      service: 'krowdit',
      name: 'Krowdit',
      accountName,
      tools: [{ name: 'growth_ga4_run_report', inputSchema: { type: 'object' } }],
    });
    const walled = wallCard(
      {
        agent: {
          name: 'growth-analyst',
          title: 'Growth Analyst',
          tools: [
            'apps',
            'task',
            'manage_personal_context',
            'skills',
            'sign_in',
            'files',
            'mcp__Krowdit__growth_ga4_run_report',
          ],
          instructions: 'Investigate.',
        },
        connectedApps: [
          app('rkmd-ga4', 'ads@rkmd.example'),
          app('formulaic-ga4', 'data@formulaic.example'),
          profile('rkmd-ads-profile', 'rkmd · growth-analyst: ads.example'),
          profile('rkmd-writer-profile', 'rkmd · copywriter: ads.example'),
        ],
        mcpServers: [server('krowdit-formulaic', 'formulaic')] as RuntimeContext['mcpServers'],
        history: [
          { role: 'user', text: 'Formulaic launch is in March', turnId: null },
          { role: 'assistant', text: 'Working on RKMD.', turnId: ownTurn },
        ],
        relatedConversation: [{ role: 'user', text: 'Formulaic margins are 60%' }],
        learnedSkills: [{ name: 'formulaic-launch-checklist', description: 'Launch steps' }],
        tasks: [{ id: rkmdCard }, { id: formulaicCard }] as RuntimeContext['tasks'],
      },
      {
        client: 'rkmd',
        clients: registry.clients,
        sessionTurns: new Set([ownTurn]),
        clientCards: new Set([rkmdCard]),
        namespaces,
        browserProfiles: new Set(['rkmd-ads-profile']),
      },
    );
    assert.deepEqual(
      walled.connectedApps?.map((item) => item.connectionId),
      ['rkmd-ga4', 'rkmd-ads-profile'],
    );
    assert.match(walled.agent.instructions, /rkmd-ads-profile/);
    assert.doesNotMatch(walled.agent.instructions, /rkmd-writer-profile/);
    assert.deepEqual(walled.mcpServers, []);
    assert.equal(walled.memory, '');
    assert.equal(walled.relatedConversation, undefined);
    assert.deepEqual(
      walled.history?.map((item) => item.text),
      ['Working on RKMD.'],
    );
    assert.deepEqual(
      walled.tasks?.map((task) => task.id),
      [rkmdCard],
    );
    assert.match(walled.agent.instructions, /ROAS target is 3\.1/);
    assert.doesNotMatch(walled.agent.instructions, /launch is secret/);

    let memoryPrepared = false;
    const outcomes: string[] = [];
    await runAs(
      walled.agent,
      async (tools, options) => {
        assert.equal(tools.has('mcp__Krowdit__growth_ga4_run_report'), false);
        const attempt = async (name: string, params: unknown) => {
          try {
            await options.runTool(name, params, async () => ({
              content: [{ type: 'text', text: 'ran' }],
            }));
            outcomes.push(`${name}: ran`);
          } catch (error) {
            outcomes.push(`${name}: ${(error as Error).message}`);
          }
        };
        await attempt('apps', {
          action: 'GOOGLEANALYTICS_RUN_REPORT',
          args: { connectionId: 'rkmd-ga4' },
        });
        await attempt('apps', {
          action: 'GOOGLEANALYTICS_RUN_REPORT',
          args: { connectionId: 'formulaic-ga4' },
        });
        await attempt('apps', { action: 'GOOGLEANALYTICS_RUN_REPORT', args: {} });
        await attempt('mcp__Krowdit__growth_ga4_run_report', {});
        await attempt('manage_personal_context', {
          action: 'memory_find',
          args: { query: 'launch' },
        });
        await attempt('task', { action: 'list' });
        await attempt('skills', { action: 'read', name: 'formulaic-launch-checklist' });
        await attempt('sign_in', { origin: 'https://ads.example' });
        await attempt('files', { action: 'list', path: '~/Clients/Formulaic' });
      },
      walled,
      async () => {
        memoryPrepared = true;
        return undefined;
      },
    );
    assert.equal(memoryPrepared, false);
    assert.equal(outcomes[0], 'apps: ran');
    assert.match(outcomes[1]!, /formulaic-ga4 belongs to Formulaic, not RKMD/);
    assert.match(outcomes[2]!, /must name the connectionId.*rkmd-ga4/);
    assert.match(outcomes[3]!, /isn't one of RKMD's connections/);
    assert.match(outcomes[4]!, /memory, history.*shared across every client/);
    assert.match(outcomes[5]!, /holds every client's cards/);
    assert.match(outcomes[6]!, /Learned procedures are shared/);
    assert.equal(outcomes[7], 'sign_in: ran');
    assert.match(outcomes[8]!, /computer holds every client's files/);
    assert.equal(walled.learnedSkills, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const healthy = (fields: Partial<CardSnapshot> = {}): CardSnapshot => ({
  taskId: randomUUID(),
  title: 'Find the RKMD conversion drop',
  agent: 'growth-analyst',
  estimateMinutes: 30,
  agentMinutes: 20,
  budgetUsd: 4,
  spentUsd: 1.5,
  asks: [{ id: randomUUID(), agent: 'copywriter', flagged: false }],
  questions: ['Which week should I compare?', 'Did the copy change?'],
  calls: ['apps:ga4', 'browser:open', 'apps:ga4', 'browser:snapshot'].map((fingerprint) => ({
    id: randomUUID(),
    name: fingerprint.split(':')[0]!,
    fingerprint,
  })),
  idleSince: null,
  handled: [],
  ...fields,
});
const board = (...cards: CardSnapshot[]) => ({ now: '2026-11-15T12:00:00.000Z', cards });
const kinds = (snapshot: ReturnType<typeof board>) => scanBoard(snapshot).map((flag) => flag.kind);

test('a healthy board has no flags', () => {
  assert.deepEqual(scanBoard(board(healthy(), healthy({ agentMinutes: 59 }))), []);
});

test('a card past twice its estimate is flagged as stalled, once per doubling', () => {
  const card = healthy({ estimateMinutes: 30, agentMinutes: 61 });
  const [flag] = scanBoard(board(card));
  assert.equal(flag?.kind, 'stalled');
  assert.equal(flag?.taskId, card.taskId);
  assert.match(flag?.detail ?? '', /61 agent minutes.*30/);
  assert.deepEqual(kinds(board({ ...card, handled: [flag!.key] })), []);
  assert.deepEqual(kinds(board({ ...card, agentMinutes: 125, handled: [flag!.key] })), ['stalled']);
});

test('a card repeating the same question is flagged', () => {
  const card = healthy({
    questions: ['Which week should I compare?', 'which  week should I compare', 'Other?'],
  });
  const [flag] = scanBoard(board(card));
  assert.equal(flag?.kind, 'repeated_question');
  assert.match(flag?.detail ?? '', /2 times.*Which week should I compare\?/);
  assert.deepEqual(kinds(board({ ...card, handled: [flag!.key] })), []);
});

test('an ask over its cap is flagged once', () => {
  const ask = { id: randomUUID(), agent: 'copywriter', flagged: true };
  const card = healthy({ asks: [ask] });
  const [flag] = scanBoard(board(card));
  assert.equal(flag?.kind, 'ask_over_cap');
  assert.match(flag?.detail ?? '', new RegExp(`copywriter.*${ask.id}`));
  assert.deepEqual(kinds(board({ ...card, handled: [flag!.key] })), []);
});

test('a card looping on the same tool call is flagged, and again only after more calls', () => {
  const call = () => ({ id: randomUUID(), name: 'browser', fingerprint: 'browser:click-next' });
  const calls = [call(), call(), { ...call(), fingerprint: 'apps:ga4' }, call(), call()];
  const card = healthy({ calls });
  const [flag] = scanBoard(board(card));
  assert.equal(flag?.kind, 'loop');
  assert.match(flag?.detail ?? '', /browser 4 times/);
  assert.deepEqual(kinds(board({ ...card, handled: [flag!.key] })), []);
  assert.deepEqual(kinds(board({ ...card, calls: [...calls, call()], handled: [flag!.key] })), [
    'loop',
  ]);
  assert.deepEqual(kinds(board(healthy({ calls: calls.slice(1) }))), []);
});

test('a card over its budget is flagged, and a card with no budget never is', () => {
  const [flag] = scanBoard(board(healthy({ budgetUsd: 4, spentUsd: 4.2 })));
  assert.equal(flag?.kind, 'over_budget');
  assert.match(flag?.detail ?? '', /\$4\.20.*\$4\.00/);
  assert.deepEqual(kinds(board(healthy({ budgetUsd: null, spentUsd: 40 }))), []);
});

test('a card left open with nothing running for 15 minutes is flagged as unfinished', () => {
  assert.deepEqual(kinds(board(healthy({ idleSince: '2026-11-15T11:50:00.000Z' }))), []);
  const card = healthy({ idleSince: '2026-11-15T11:40:00.000Z' });
  const [flag] = scanBoard(board(card));
  assert.equal(flag?.kind, 'unfinished');
  assert.deepEqual(kinds(board({ ...card, handled: [flag!.key] })), []);
});

test('one card can carry several flags at once', () => {
  assert.deepEqual(kinds(board(healthy({ agentMinutes: 90, spentUsd: 9 }))).sort(), [
    'over_budget',
    'stalled',
  ]);
});

const analyst = `---
title: Growth Analyst
role: Finds why a client's growth metrics moved.
tools: [browser, apps, send_message]
budget:
  cardUsd: 4
---
Investigate metric changes with evidence.
`;

test(
  'a Router card runs as its owner agent and closes only with a structured result or one question',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 },
  async (t) => {
    const pg = (await import('pg')).default;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_cards_${suffix}`;
    const bossSchema = `test_cards_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const root = await configRoot({
      'core/team.md': team('router'),
      'core/router.md': agentFile(['task', 'ask_user', 'send_message']),
      'core/pm.md': `---
title: PM
role: Keeps cards on track.
tools: [task, browser, apps]
---
Keep every card moving.
`,
      'growth/team.md': `---
lead: growth-analyst
routing: Owns client growth metrics, traffic and conversion questions.
---
`,
      'growth/growth-analyst.md': analyst,
      'growth/ads-buyer.md': `---
title: Ads Buyer
role: Runs paid campaigns in each client's ad accounts.
tools: [browser, browser_session, sign_in]
---
Run paid campaigns.
`,
      ...clientConfigs,
      'creative/team.md': `---
lead: copywriter
routing: Writes ad and email copy.
---
`,
      'creative/copywriter.md': `---
title: Copywriter
role: Writes copy in the client's voice.
tools: [send_message]
---
Write copy in the client's brand voice.
`,
      'growth/paid-analyst.md': `---
title: Paid Analyst
role: Finds paid media growth.
tools: [apps]
---
Look for paid media wins.
`,
      'growth/seo-analyst.md': `---
title: SEO Analyst
role: Finds organic search growth.
tools: [browser]
skills: [keyword-gaps]
---
Look for organic search wins.
`,
    });
    const skillsRoot = await configRoot({
      'keyword-gaps/SKILL.md': `---
name: keyword-gaps
description: Find keyword gaps.
---

Compare the client's ranking keywords with three competitors.
`,
    });
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createTasks } = await import('../src/server/tasks.ts');
    const { createCards } = await import('../src/server/agents/cards.ts');
    const { createPm } = await import('../src/server/agents/pm.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { ownerId } = await import('../src/server/config.ts');
    t.after(async () => {
      await thread.stopThreadWorkers();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
      await rm(skillsRoot, { recursive: true, force: true });
    });
    const registry = await loadAgentRegistry(root);
    assert.deepEqual(registry.problems, []);
    const agents = createAgentBinding({
      knownTools: Object.keys(toolDefinitions),
      namespaces,
      card: async () => undefined,
      wallRecords: async () => ({ sessionTurns: new Set(), clientCards: new Set() }),
      root,
      skills: { root: skillsRoot },
    });
    const cards = createCards({
      pool: db.pool,
      ownerId,
      registry: async () => registry,
      participant: agents.participant,
    });
    const tasks = createTasks({ pool: db.pool, ownerId, cards: cards.hooks });
    await db.initializeDatabase();
    await thread.initializeThreads();
    await createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: thread.boss,
      enqueueTurn: thread.enqueueTurn,
      refresh() {},
    }).initialize({ workers: false });
    await tasks.initialize();
    await cards.initialize();
    const pm = createPm({ pool: db.pool, ownerId, registry: async () => registry, cards });
    await pm.initialize();
    const { createLedger } = await import('../src/server/ledger.ts');
    await createLedger({ pool: db.pool, ownerId }).initialize();
    const running = async (turnId: string) => {
      await db.pool.query("UPDATE turns SET status='running',started_at=now() WHERE id=$1", [
        turnId,
      ]);
      return { threadId: (await thread.activeThread()).id, turnId };
    };
    const ask = async (text: string) => {
      const submitted = await thread.submitUserMessage(text);
      return { turn: await running(submitted.turnId), messageId: submitted.messageId };
    };
    const start = (fields: Record<string, unknown>) => ({
      action: 'start',
      title: 'Find the RKMD conversion drop',
      doneWhen: 'The cause of the drop is known with evidence.',
      now: 'Reading the conversion reports.',
      message: 'The Growth Analyst has this.',
      ...fields,
    });
    const cardTurn = async (taskId: string) => {
      const work = await running(
        (
          await db.pool.query<{ id: string }>(
            'SELECT id FROM turns WHERE session_id=$1 ORDER BY created_at LIMIT 1',
            [taskId],
          )
        ).rows[0]!.id,
      );
      await tasks.inherit(work);
      return work;
    };

    await t.test('the Router must name an owner agent and an estimate', async () => {
      const { turn, messageId } = await ask('Why did RKMD conversions drop this week?');
      await assert.rejects(
        tasks.execute(turn, start({ estimateMinutes: 30 }), messageId),
        /owner agent.*growth-analyst/,
      );
      await assert.rejects(
        tasks.execute(turn, start({ agent: 'router', estimateMinutes: 30 }), messageId),
        /not an agent that can own a card/,
      );
      await assert.rejects(
        tasks.execute(turn, start({ agent: 'growth-analyst', client: 'rkmd' }), messageId),
        /estimateMinutes/,
      );
      assert.equal((await db.pool.query('SELECT 1 FROM tasks')).rowCount, 0);
      const chat = bindAgent(registry, { threadId: turn.threadId, sessionId: turn.threadId });
      assert.match(chat.agent?.instructions ?? '', /growth-analyst, Growth Analyst/);
      assert.match(chat.agent?.instructions ?? '', /Owns client growth metrics/);
    });

    await t.test('a card without a known client cannot start', async () => {
      const { turn, messageId } = await ask('Look into conversions.');
      await assert.rejects(
        tasks.execute(turn, start({ agent: 'growth-analyst', estimateMinutes: 30 }), messageId),
        /needs the one client.*formulaic, rkmd/,
      );
      await assert.rejects(
        tasks.execute(
          turn,
          start({ agent: 'growth-analyst', client: 'acme', estimateMinutes: 30 }),
          messageId,
        ),
        /acme is not a client/,
      );
      assert.equal((await db.pool.query('SELECT 1 FROM tasks')).rowCount, 0);
    });

    await t.test('a started card records its owner agent and runs as that agent', async () => {
      const { turn, messageId } = await ask('Find out why RKMD conversions dropped.');
      const task = (await tasks.execute(
        turn,
        start({
          agent: 'growth-analyst',
          client: 'rkmd',
          estimateMinutes: 45,
          cardType: 'investigation',
        }),
        messageId,
      )) as { id: string };
      const row = (await db.pool.query('SELECT * FROM agent_cards WHERE task_id=$1', [task.id]))
        .rows[0];
      assert.equal(row.agent, 'growth-analyst');
      assert.equal(row.card_type, 'investigation');
      assert.equal(row.estimate_minutes, 45);
      assert.equal(Number(row.budget_usd), 4);
      assert.deepEqual(await cards.cardFor(task.id), {
        agent: 'growth-analyst',
        client: 'rkmd',
        role: 'owner',
        card_type: 'investigation',
      });
      const bound = bindAgent(
        registry,
        { threadId: turn.threadId, sessionId: task.id },
        (await cards.cardFor(task.id))?.agent,
      ).agent;
      assert.equal(bound?.name, 'growth-analyst');
      assert.deepEqual(bound?.tools, ['browser', 'apps', 'send_message', 'task']);
      assert.match(bound?.instructions ?? '', /Investigate metric changes with evidence\./);
      assert.match(bound?.instructions ?? '', /conclusion, evidence/);
      const binding = createAgentBinding({
        knownTools: [],
        namespaces,
        card: cards.cardFor,
        wallRecords: cards.wallRecords,
        root,
      });
      const walled = (await binding.bind({ threadId: turn.threadId, sessionId: task.id })).agent;
      assert.equal(walled?.name, 'growth-analyst');
      assert.equal(walled?.wall?.client, 'rkmd');
      assert.equal(
        (await binding.bind({ threadId: turn.threadId, sessionId: randomUUID() })).agent,
        undefined,
      );
      const work = await cardTurn(task.id);
      assert.equal(await cards.isCardTurn(work.turnId), true);
      assert.equal(await cards.isCardTurn(turn.turnId), false);
    });

    await t.test('a card finish without a valid result or one question is refused', async () => {
      const { turn, messageId } = await ask('Check the Formulaic signup drop.');
      const task = (await tasks.execute(
        turn,
        start({ agent: 'growth-analyst', client: 'formulaic', estimateMinutes: 20 }),
        messageId,
      )) as { id: string };
      const work = await cardTurn(task.id);
      const finish = (fields: Record<string, unknown>) =>
        tasks.execute(work, { action: 'finish', id: task.id, status: 'done', ...fields }, null);
      await assert.rejects(
        finish({ result: 'Looked into it.' }),
        /missing conclusion, evidence, nextAction, confidence/,
      );
      await assert.rejects(
        finish({ card: { conclusion: 'Paid search lost budget.', nextAction: 'Restore it.' } }),
        /missing evidence, confidence/,
      );
      await assert.rejects(
        finish({
          card: { conclusion: 'x', evidence: ['y'], nextAction: 'z', confidence: 'certain' },
        }),
        /missing confidence/,
      );
      await assert.rejects(
        finish({ question: 'Should I pause it? Or cut the bid?' }),
        /exactly one question/,
      );
      await assert.rejects(
        finish({ question: 'Pause it?', card: { conclusion: 'x' } }),
        /both a result and a question/,
      );
      const state = async () =>
        (await db.pool.query('SELECT state,result FROM tasks WHERE id=$1', [task.id])).rows[0];
      assert.equal((await state()).state, 'open');
      await finish({
        card: {
          conclusion: 'Signups fell because the paid search budget ran out on Tuesday.',
          evidence: ['GA4 paid sessions fell 80% from Tuesday.', 'Spend hit the cap on Tuesday.'],
          nextAction: 'Ask the owner to raise the paid search cap.',
          confidence: 'High',
        },
      });
      assert.equal((await state()).state, 'done');
      assert.match((await state()).result, /^Signups fell[\s\S]*Confidence: high$/);
      assert.deepEqual(
        (await db.pool.query('SELECT result FROM agent_cards WHERE task_id=$1', [task.id])).rows[0]
          .result.evidence,
        ['GA4 paid sessions fell 80% from Tuesday.', 'Spend hit the cap on Tuesday.'],
      );
    });

    await t.test(
      'with agents off the chat starts plain tasks and refuses card fields',
      async () => {
        const off = createCards({ pool: db.pool, ownerId, registry: async () => undefined });
        const plain = createTasks({ pool: db.pool, ownerId, cards: off.hooks });
        const { turn, messageId } = await ask('Summarise the RKMD weekly report.');
        await assert.rejects(
          plain.execute(turn, start({ agent: 'growth-analyst', estimateMinutes: 10 }), messageId),
          /Agents are off/,
        );
        const task = (await plain.execute(turn, start({}), messageId)) as { id: string };
        assert.equal(await off.cardFor(task.id), undefined);
        const work = await cardTurn(task.id);
        await plain.execute(
          work,
          { action: 'finish', id: task.id, status: 'done', result: 'Synthetic summary.' },
          null,
        );
        assert.equal(
          (await db.pool.query('SELECT result FROM tasks WHERE id=$1', [task.id])).rows[0].result,
          'Synthetic summary.',
        );
      },
    );

    await t.test(
      'a card opens and signs in only to its own agent and client browser profiles',
      async () => {
        const { createBrowserConnections } = await import('../src/server/browser-connections.ts');
        const { createAgentBrowserProfiles } =
          await import('../src/server/agents/browser-profiles.ts');
        const bound: string[] = [];
        const page = { origin: 'https://ads.example.com', url: 'https://ads.example.com/home' };
        const connections = await createBrowserConnections(db.pool, {
          ownerId,
          computer: fakeComputer({
            bindProfile: async (_browser, profileId) => {
              bound.push(profileId);
            },
            act: async () => ({ text: 'Campaigns', url: page.url }),
            currentPage: async () => page,
          }),
        });
        const profiles = createAgentBrowserProfiles({ pool: db.pool, ownerId });
        await profiles.initialize();
        const open = profiles.browserConnection((request, turn, signal) =>
          connections.request(request, turn, signal),
        );
        const card = async (agent: string, client: string) => {
          const { turn, messageId } = await ask(`Check the ${client} ad account.`);
          const task = (await tasks.execute(
            turn,
            start({ agent, client, estimateMinutes: 10 }),
            messageId,
          )) as { id: string };
          return { ...(await cardTurn(task.id)), browserId: task.id };
        };
        const url = 'https://ads.example.com/login';
        const first = await card('ads-buyer', 'rkmd');
        await assert.rejects(
          profiles.signIn(first, { kind: 'password' }),
          /signs in only inside its own saved browser profile/,
        );
        const made = (await open({ action: 'connect', url }, first)) as {
          status: string;
          connectionId: string;
        };
        assert.equal(made.status, 'profile_opened');
        assert.equal(await profiles.signIn(first, { kind: 'password' }), true);
        await assert.rejects(
          profiles.signIn(first, { kind: 'password', savedLoginId: randomUUID() }),
          /Saved logins belong to the owner/,
        );
        await assert.rejects(
          profiles.signIn(first, { kind: 'otp', emailCode: true }),
          /owner's mailbox/,
        );
        assert.deepEqual(
          await open(
            { action: 'save', url, connectionId: made.connectionId, signedIn: true },
            first,
          ),
          { status: 'session_saved', connectionId: made.connectionId },
        );
        assert.match(
          (
            await db.pool.query('SELECT label FROM browser_connections WHERE id=$1', [
              made.connectionId,
            ])
          ).rows[0].label,
          /^rkmd · ads-buyer: ads\.example\.com$/,
        );
        assert.deepEqual([...(await profiles.owned('ads-buyer', 'rkmd'))], [made.connectionId]);
        assert.deepEqual([...(await profiles.owned('ads-buyer', 'formulaic'))], []);
        assert.deepEqual([...(await profiles.owned('growth-analyst', 'rkmd'))], []);

        await db.pool.query("UPDATE turns SET status='succeeded' WHERE session_id=$1", [
          first.browserId,
        ]);
        const later = await card('ads-buyer', 'rkmd');
        const reopened = (await open(
          { action: 'use', url, connectionId: made.connectionId },
          later,
        )) as { status: string };
        assert.equal(reopened.status, 'session_opened');
        assert.equal(bound.at(-1), bound[0]);
        assert.equal(await profiles.signIn(later, { kind: 'password' }), true);

        const before = bound.length;
        await assert.rejects(
          open(
            { action: 'use', url, connectionId: made.connectionId },
            await card('growth-analyst', 'rkmd'),
          ),
          /belongs to ads-buyer for rkmd, not growth-analyst for rkmd/,
        );
        await assert.rejects(
          open(
            { action: 'use', url, connectionId: made.connectionId },
            await card('ads-buyer', 'formulaic'),
          ),
          /belongs to ads-buyer for rkmd, not ads-buyer for formulaic/,
        );
        const { turn: chat } = await ask('Open the ads account for me.');
        const owners = (await open({ action: 'connect', url, label: 'Ads' }, chat)) as {
          connectionId: string;
        };
        assert.equal(await profiles.signIn(chat, { kind: 'password' }), false);
        await assert.rejects(
          open({ action: 'use', url, connectionId: owners.connectionId }, later),
          /isn't one of ads-buyer's profiles for rkmd/,
        );
        assert.equal(bound.length, before + 1);
      },
    );

    await t.test('a card can close with exactly one question for the owner', async () => {
      const { turn, messageId } = await ask('Should we change the RKMD Taboola bids?');
      const task = (await tasks.execute(
        turn,
        start({ agent: 'growth-analyst', client: 'rkmd', estimateMinutes: 15 }),
        messageId,
      )) as { id: string };
      const work = await cardTurn(task.id);
      await tasks.execute(
        work,
        {
          action: 'finish',
          id: task.id,
          status: 'done',
          question: 'Can I lower the RKMD Taboola bids by 10%?',
        },
        null,
      );
      const closed = (await db.pool.query('SELECT state,result FROM tasks WHERE id=$1', [task.id]))
        .rows[0];
      assert.deepEqual(closed, {
        state: 'done',
        result: 'Can I lower the RKMD Taboola bids by 10%?',
      });
    });

    await t.test(
      'a client at its monthly cap gets no new card turns and the reason is recorded',
      async () => {
        const { createClientBudget } = await import('../src/server/agents/client-budget.ts');
        const { createLedger } = await import('../src/server/ledger.ts');
        await createLedger({ pool: db.pool, ownerId }).initialize();
        const budget = createClientBudget({
          pool: db.pool,
          ownerId,
          registry: async () => registry,
        });
        await budget.initialize();
        const card = async (client: string) => {
          const { turn, messageId } = await ask(`Check ${client} spend.`);
          const task = (await tasks.execute(
            turn,
            start({ agent: 'growth-analyst', client, estimateMinutes: 10 }),
            messageId,
          )) as { id: string };
          return { task, work: await cardTurn(task.id) };
        };
        const rkmd = await card('rkmd');
        const formulaic = await card('formulaic');
        const usage = (turnId: string, sessionId: string, cost: number, createdAt = 'now()') =>
          db.pool.query(
            `INSERT INTO model_usage(id,owner_id,turn_id,session_id,cost_usd,created_at)
           VALUES($1,$2,$3,$4,$5,${createdAt})`,
            [randomUUID(), ownerId, turnId, sessionId, cost],
          );
        await usage(rkmd.work.turnId, rkmd.task.id, 300);
        await usage(rkmd.work.turnId, rkmd.task.id, 400, "now()-interval '45 days'");
        await usage(formulaic.work.turnId, formulaic.task.id, 120);
        await budget.admit({ turnId: rkmd.work.turnId }, 'rkmd');
        await usage(rkmd.work.turnId, rkmd.task.id, 200.5);
        await assert.rejects(
          budget.admit({ turnId: rkmd.work.turnId }, 'rkmd'),
          /RKMD has used \$500\.50 of its \$500\.00 monthly model budget/,
        );
        await budget.admit({ turnId: formulaic.work.turnId }, 'formulaic');
        await budget.admit({ turnId: rkmd.work.turnId, currentMessageId: randomUUID() }, 'rkmd');
        const pause = (
          await db.pool.query(
            'SELECT client,spent_usd,cap_usd,reason,turn_id FROM client_budget_pauses',
          )
        ).rows;
        assert.equal(pause.length, 1);
        assert.equal(pause[0].client, 'rkmd');
        assert.equal(pause[0].spent_usd, 500.5);
        assert.equal(pause[0].turn_id, rkmd.work.turnId);
        assert.match(pause[0].reason, /monthly model budget/);
        const spend = await budget.spend();
        assert.deepEqual(
          spend
            .sort((a, b) => a.client.localeCompare(b.client))
            .map(({ client, spentUsd, capUsd, reason }) => ({
              client,
              spentUsd,
              capUsd,
              paused: Boolean(reason),
            })),
          [
            { client: 'formulaic', spentUsd: 120, capUsd: 500, paused: false },
            { client: 'rkmd', spentUsd: 500.5, capUsd: 500, paused: true },
          ],
        );
      },
    );

    const finishCard = (
      work: { threadId: string; turnId: string },
      id: string,
      conclusion: string,
    ) =>
      tasks.execute(
        work,
        {
          action: 'finish',
          id,
          status: 'done',
          card: {
            conclusion,
            evidence: ['Synthetic report.'],
            nextAction: 'None.',
            confidence: 'high',
          },
        },
        null,
      );
    const firstTurn = async (taskId: string) =>
      (
        await db.pool.query<{ id: string; prompt: string; held: boolean; status: string }>(
          `SELECT id,prompt,status,start_after IS NOT NULL AND start_after>now() AS held
           FROM turns WHERE session_id=$1 ORDER BY created_at,id LIMIT 1`,
          [taskId],
        )
      ).rows[0]!;
    const resumes = async (sessionId: string) =>
      (
        await db.pool.query<{ prompt: string }>(
          "SELECT prompt FROM turns WHERE session_id=$1 AND source='resume' ORDER BY created_at,id",
          [sessionId],
        )
      ).rows.map((row) => row.prompt);
    const routerCard = async (text: string, fields: Record<string, unknown> = {}) => {
      const { turn, messageId } = await ask(text);
      const task = (await tasks.execute(
        turn,
        start({ agent: 'growth-analyst', client: 'rkmd', estimateMinutes: 30, ...fields }),
        messageId,
      )) as { id: string };
      return { turn, task };
    };

    await t.test('a card agent splits its card into child cards for other agents', async () => {
      const { task: parent } = await routerCard('Plan the Formulaic spring campaign.', {
        client: 'formulaic',
      });
      const work = await cardTurn(parent.id);
      await assert.rejects(
        tasks.execute(work, start({ estimateMinutes: 10 }), null),
        /already has a task/,
      );
      const child = (await tasks.execute(
        work,
        start({
          title: 'Write three headlines',
          brief: 'Three headlines for the spring sale in the Formulaic voice.',
          agent: 'copywriter',
          estimateMinutes: 15,
        }),
        null,
      )) as { id: string };
      assert.notEqual(child.id, parent.id);
      const row = (await db.pool.query('SELECT * FROM agent_cards WHERE task_id=$1', [child.id]))
        .rows[0];
      assert.equal(row.parent_task_id, parent.id);
      assert.equal(row.agent, 'copywriter');
      assert.deepEqual(await cards.cardFor(child.id), {
        agent: 'copywriter',
        client: 'formulaic',
        role: 'owner',
        card_type: 'work',
      });
      assert.equal((await cards.cardFor(parent.id))?.agent, 'growth-analyst');
      await assert.rejects(
        tasks.execute(
          work,
          start({ title: 'RKMD copy', agent: 'copywriter', client: 'rkmd', estimateMinutes: 5 }),
          null,
        ),
        /stays with its parent's client, formulaic/,
      );
      const queued = await firstTurn(child.id);
      assert.equal(queued.status, 'queued');
      assert.equal(queued.held, false);
      assert.match(queued.prompt, /Three headlines for the spring sale/);
      const childWork = await cardTurn(child.id);
      await finishCard(childWork, child.id, 'Headlines written.');
      const resumed = await resumes(parent.id);
      assert.equal(resumed.length, 1);
      assert.match(resumed[0]!, /Write three headlines[\s\S]*Headlines written\./);
    });

    await t.test('a plain task session cannot start cards', async () => {
      const work = await running(
        await thread.enqueueTurn('Tidy my notes.', { source: 'task', sessionId: randomUUID() }),
      );
      await tasks.execute(work, start({}), null);
      await assert.rejects(
        tasks.execute(work, start({ agent: 'copywriter', estimateMinutes: 5 }), null),
        /Only the Router or a card agent/,
      );
    });

    await t.test('a blocked card does not run until its blockers close', async () => {
      const { task: first } = await routerCard('Pull the RKMD Taboola numbers.');
      const unknown = await ask('Write it after an unknown card.');
      await assert.rejects(
        tasks.execute(
          unknown.turn,
          start({
            agent: 'copywriter',
            client: 'rkmd',
            estimateMinutes: 10,
            blockedBy: [randomUUID()],
          }),
          unknown.messageId,
        ),
        /not a rkmd card/,
      );
      await assert.rejects(
        tasks.execute(
          unknown.turn,
          start({
            agent: 'copywriter',
            client: 'formulaic',
            estimateMinutes: 10,
            blockedBy: [first.id],
          }),
          unknown.messageId,
        ),
        /not a formulaic card/,
      );
      const { turn: chat, messageId } = await ask('Write the RKMD weekly summary after that.');
      const second = (await tasks.execute(
        chat,
        start({ agent: 'copywriter', client: 'rkmd', estimateMinutes: 10, blockedBy: [first.id] }),
        messageId,
      )) as { id: string };
      assert.equal((await firstTurn(second.id)).held, true);
      const work = await cardTurn(first.id);
      await tasks.execute(
        work,
        { action: 'finish', id: first.id, status: 'done', question: 'Which week should I pull?' },
        null,
      );
      assert.equal((await firstTurn(second.id)).held, true);
      await db.pool.query("UPDATE turns SET status='succeeded',finished_at=now() WHERE id=$1", [
        work.turnId,
      ]);
      const answered = await running(
        await thread.enqueueTurn('Last week.', {
          source: 'task',
          sessionId: first.id,
          background: true,
        }),
      );
      await db.pool.query("UPDATE tasks SET state='open',closed_at=NULL WHERE id=$1", [first.id]);
      await tasks.inherit(answered);
      await finishCard(answered, first.id, 'Taboola CPC rose 12%.');
      const released = await firstTurn(second.id);
      assert.equal(released.held, false);
      assert.match(released.prompt, /Taboola CPC rose 12%\./);
      const { task: third } = await routerCard('Check the RKMD GA4 goals.');
      const { turn: chat2, messageId: message2 } = await ask('Summarize the goals after that.');
      const fourth = (await tasks.execute(
        chat2,
        start({ agent: 'copywriter', client: 'rkmd', estimateMinutes: 10, blockedBy: [third.id] }),
        message2,
      )) as { id: string };
      assert.equal((await firstTurn(fourth.id)).held, true);
      const { turn: stopper, messageId: stopMessage } = await ask('Stop the GA4 goals card.');
      await tasks.execute(stopper, { action: 'stop', id: third.id }, stopMessage);
      assert.equal((await firstTurn(fourth.id)).held, false);
    });

    await t.test(
      'an ask allows 3 back-and-forths, then the 4th is refused and flagged',
      async () => {
        const { task } = await routerCard('Find why Formulaic refunds rose.', {
          client: 'formulaic',
        });
        const work = await cardTurn(task.id);
        await assert.rejects(
          cards.act(work, { action: 'ask', id: task.id, agent: 'growth-analyst', question: 'Me?' }),
          /another agent/,
        );
        for (let round = 1; round <= 3; round++) {
          const asked = (await cards.act(work, {
            action: 'ask',
            id: task.id,
            agent: 'copywriter',
            question: `Did the refund email copy change, round ${round}?`,
          })) as { ask: string };
          await assert.rejects(
            cards.act(work, {
              action: 'ask',
              id: task.id,
              agent: 'copywriter',
              question: 'Again?',
            }),
            /waiting for/,
          );
          const answering = await running(
            (
              await db.pool.query<{ id: string }>(
                "SELECT id FROM turns WHERE session_id=$1 AND status='queued' ORDER BY created_at LIMIT 1",
                [asked.ask],
              )
            ).rows[0]!.id,
          );
          assert.deepEqual(await cards.cardFor(asked.ask), {
            agent: 'copywriter',
            client: 'formulaic',
            role: 'asked',
            card_type: null,
          });
          const binding = createAgentBinding({
            knownTools: Object.keys(toolDefinitions),
            namespaces,
            card: cards.cardFor,
            wallRecords: cards.wallRecords,
            root,
          });
          const bound = (await binding.bind({ threadId: answering.threadId, sessionId: asked.ask }))
            .agent;
          assert.equal(bound?.name, 'copywriter');
          assert.equal(bound?.wall?.client, 'formulaic');
          assert.match(bound?.instructions ?? '', /brand voice[\s\S]*task answer/);
          assert.doesNotMatch(bound?.instructions ?? '', /You own this card/);
          await assert.rejects(
            cards.act(answering, start({ agent: 'copywriter', estimateMinutes: 5 })),
            /answer/,
          );
          await cards.act(answering, {
            action: 'answer',
            id: asked.ask,
            answer: `No change in round ${round}.`,
          });
          await assert.rejects(
            cards.act(answering, { action: 'answer', id: asked.ask, answer: 'Twice.' }),
            /no question/,
          );
          assert.match(
            (await resumes(task.id)).at(-1)!,
            new RegExp(`No change in round ${round}\\.`),
          );
        }
        await assert.rejects(
          cards.act(work, {
            action: 'ask',
            id: task.id,
            agent: 'copywriter',
            question: 'Once more?',
          }),
          /3 back-and-forths/,
        );
        assert.ok((await cards.read([task.id]))[0]?.asks[0]?.flagged);
        await db.pool.query(
          `UPDATE agent_card_asks SET exchanges='[{"question":"Stuck?"}]',flagged_at=NULL WHERE task_id=$1`,
          [task.id],
        );
        await db.pool.query(
          "UPDATE turns SET status='failed' WHERE session_id=(SELECT id FROM agent_card_asks WHERE task_id=$1) AND status IN ('queued','running')",
          [task.id],
        );
        const retried = (await cards.act(work, {
          action: 'ask',
          id: task.id,
          agent: 'copywriter',
          question: 'Did anything change after all?',
        })) as { exchange: number };
        assert.equal(retried.exchange, 2);
        const [card] = await cards.read([task.id]);
        assert.equal(card?.asks.length, 1);
        assert.equal(card?.asks[0]?.exchanges, 2);
        assert.ok(card?.asks[0]?.flagged);
        const { createClientBudget } = await import('../src/server/agents/client-budget.ts');
        const budget = createClientBudget({
          pool: db.pool,
          ownerId,
          registry: async () => registry,
        });
        const before = (await budget.spend()).find((row) => row.client === 'formulaic')!.spentUsd;
        await db.pool.query(
          `INSERT INTO model_usage(id,owner_id,turn_id,session_id,cost_usd)
           SELECT $1,$2,NULL,id,7 FROM agent_card_asks WHERE task_id=$3`,
          [randomUUID(), ownerId, task.id],
        );
        assert.equal(
          (await budget.spend()).find((row) => row.client === 'formulaic')!.spentUsd,
          before + 7,
        );
      },
    );

    await t.test('agent time and waiting-on-owner time are recorded separately', async () => {
      const { task } = await routerCard('Audit the Krowdit Stripe churn.', { estimateMinutes: 40 });
      const first = await cardTurn(task.id);
      await db.pool.query(
        `UPDATE turns SET created_at=now()-interval '30 minutes',started_at=now()-interval '30 minutes',
         finished_at=now()-interval '5 minutes',status='cancelled',waiting_reason='question' WHERE id=$1`,
        [first.turnId],
      );
      await db.pool.query(
        `INSERT INTO turn_events(id,turn_id,type,summary,created_at)
         VALUES(gen_random_uuid(),$1,'waiting','Waiting for your input.',now()-interval '20 minutes')`,
        [first.turnId],
      );
      const reply = await thread.enqueueTurn('Yes, include annual plans.', {
        source: 'task',
        sessionId: task.id,
        background: true,
      });
      await db.pool.query(
        `UPDATE turns SET created_at=now()-interval '5 minutes',started_at=now()-interval '5 minutes',
         finished_at=now()-interval '2 minutes',status='succeeded' WHERE id=$1`,
        [reply],
      );
      const [card] = await cards.read([task.id]);
      assert.equal(card?.estimateMinutes, 40);
      assert.equal(Math.round(card!.agentMinutes), 13);
      assert.equal(Math.round(card!.waitingMinutes), 15);
      const last = await running(
        await thread.enqueueTurn('Check trials too.', {
          source: 'task',
          sessionId: task.id,
          background: true,
        }),
      );
      await tasks.inherit(last);
      await tasks.execute(
        last,
        { action: 'finish', id: task.id, status: 'done', question: 'Should churn include trials?' },
        null,
      );
      await db.pool.query("UPDATE turns SET started_at=now()-interval '2 minutes' WHERE id=$1", [
        last.turnId,
      ]);
      await db.pool.query(
        `UPDATE turn_events SET created_at=now()-interval '1 minute' WHERE turn_id=$1 AND type='card_question'`,
        [last.turnId],
      );
      const [asking] = await cards.read([task.id]);
      assert.equal(Math.round(asking!.agentMinutes), 14);
      assert.equal(Math.round(asking!.waitingMinutes), 16);
    });

    await t.test(
      'the board shows open and recent cards by client and team, with blocked and waiting cards marked, for this owner only',
      async () => {
        const Fastify = (await import('fastify')).default;
        const { registerLocalAccess } = await import('../src/server/access.ts');
        const { createBoard } = await import('../src/server/agents/board.ts');
        const { createClientBudget } = await import('../src/server/agents/client-budget.ts');
        const budget = createClientBudget({
          pool: db.pool,
          ownerId,
          registry: async () => registry,
        });
        const board = createBoard({
          pool: db.pool,
          ownerId,
          registry: async () => registry,
          cards,
          spend: budget.spend,
        });
        const { task: lead } = await routerCard('Plan the Formulaic summer launch.', {
          title: 'Plan the summer launch',
          client: 'formulaic',
          estimateMinutes: 50,
        });
        const { task: blocked } = await routerCard('Write the launch email after the plan.', {
          client: 'formulaic',
          agent: 'copywriter',
          blockedBy: [lead.id],
        });
        const { task: asking } = await routerCard('Should RKMD move budget to Taboola?');
        const askingWork = await cardTurn(asking.id);
        await tasks.execute(
          askingWork,
          {
            action: 'finish',
            id: asking.id,
            status: 'done',
            question: 'Can I move $200 from Meta to Taboola?',
          },
          null,
        );
        await db.pool.query("UPDATE tasks SET closed_at=now()-interval '30 days' WHERE id=$1", [
          asking.id,
        ]);
        const { task: waiting } = await routerCard('Ask me which Formulaic email to rewrite.', {
          client: 'formulaic',
          blockedBy: [lead.id],
        });
        await db.pool.query(
          "UPDATE turns SET status='waiting' WHERE id=(SELECT id FROM turns WHERE session_id=$1 ORDER BY created_at LIMIT 1)",
          [waiting.id],
        );
        await db.pool.query(
          'UPDATE tasks SET turn_id=(SELECT id FROM turns WHERE session_id=$1 ORDER BY created_at LIMIT 1) WHERE id=$1',
          [waiting.id],
        );
        const { task: old } = await routerCard('Old RKMD audit.');
        await finishCard(await cardTurn(old.id), old.id, 'Audit done.');
        await db.pool.query("UPDATE tasks SET closed_at=now()-interval '30 days' WHERE id=$1", [
          old.id,
        ]);
        const { task: hidden } = await routerCard("Another owner's card.");
        await db.pool.query("UPDATE tasks SET owner_id='someone-else' WHERE id=$1", [hidden.id]);
        await db.pool.query("UPDATE agent_cards SET owner_id='someone-else' WHERE task_id=$1", [
          hidden.id,
        ]);
        const leadWork = await cardTurn(lead.id);
        await db.pool.query(
          'INSERT INTO model_usage(id,owner_id,turn_id,session_id,cost_usd) VALUES($1,$2,$3,$4,2.5)',
          [randomUUID(), ownerId, leadWork.turnId, lead.id],
        );
        await cards.act(leadWork, {
          action: 'ask',
          id: lead.id,
          agent: 'copywriter',
          question: 'Which launch headline tested best?',
        });
        const recording = await db.pool.connect();
        try {
          await cards.record(recording, lead.id, {
            actor: 'pm',
            action: 'nudge',
            detail: 'The card passed its estimate.',
          });
        } finally {
          recording.release();
        }

        const snapshot = await board.read();
        assert.equal(snapshot.enabled, true);
        const placed = new Map(
          snapshot.clients.flatMap((client) =>
            client.teams.flatMap((team) =>
              team.cards.map((card) => [card.id, { client: client.client, team: team.team, card }]),
            ),
          ),
        );
        assert.equal(placed.get(lead.id)?.client, 'formulaic');
        assert.equal(placed.get(lead.id)?.team, 'growth');
        assert.equal(placed.get(lead.id)?.card.spendUsd, 2.5);
        assert.equal(placed.get(lead.id)?.card.estimateMinutes, 50);
        assert.equal(placed.get(blocked.id)?.team, 'creative');
        assert.equal(placed.get(blocked.id)?.card.state, 'blocked');
        assert.deepEqual(placed.get(blocked.id)?.card.blockers, [
          { id: lead.id, title: 'Plan the summer launch' },
        ]);
        assert.equal(placed.get(asking.id)?.client, 'rkmd');
        assert.equal(placed.get(asking.id)?.card.state, 'needs_you');
        assert.equal(placed.get(waiting.id)?.card.state, 'needs_you');
        assert.notEqual(placed.get(lead.id)?.card.state, 'blocked');
        assert.notEqual(placed.get(lead.id)?.card.state, 'needs_you');
        assert.equal(placed.has(old.id), false);
        assert.equal(placed.has(hidden.id), false);
        const formulaic = snapshot.clients.find((client) => client.client === 'formulaic');
        assert.equal(formulaic?.capUsd, 500);
        assert.ok((formulaic?.spentUsd ?? 0) >= 2.5);

        const detail = await board.card(lead.id);
        assert.deepEqual(detail.asks, [
          {
            agent: 'copywriter',
            flagged: false,
            exchanges: [
              { question: 'Which launch headline tested best?', answer: null, unanswered: false },
            ],
          },
        ]);
        assert.deepEqual(
          detail.pmActions.map(({ actor, action, reason }) => ({ actor, action, reason })),
          [{ actor: 'pm', action: 'nudge', reason: 'The card passed its estimate.' }],
        );
        assert.deepEqual(detail.children, []);
        assert.deepEqual((await board.card(asking.id)).result, {
          question: 'Can I move $200 from Meta to Taboola?',
        });
        await assert.rejects(board.card(hidden.id), /not found for this owner/);

        const app = Fastify({ logger: false });
        registerLocalAccess(app, 4310, { key: 'synthetic-local-access' });
        board.registerRoutes(app);
        const host = { host: 'localhost:4310' };
        const signedIn = { ...host, cookie: 'nod-access-4310=synthetic-local-access' };
        assert.equal((await app.inject({ url: '/api/board', headers: host })).statusCode, 401);
        assert.equal(
          (await app.inject({ url: `/api/board/cards/${lead.id}`, headers: host })).statusCode,
          401,
        );
        const listed = await app.inject({ url: '/api/board', headers: signedIn });
        assert.equal(listed.statusCode, 200);
        assert.ok(listed.json().clients.length);
        assert.equal(
          (await app.inject({ url: `/api/board/cards/${hidden.id}`, headers: signedIn }))
            .statusCode,
          404,
        );
        await app.close();

        const off = createBoard({
          pool: db.pool,
          ownerId,
          registry: async () => undefined,
          cards,
          spend: budget.spend,
        });
        assert.deepEqual(await off.read(), { enabled: false, recentDays: 7, clients: [] });
      },
    );

    await t.test(
      'a brainstorm card runs its rounds once with 3 to 5 other agents and closes only with a top 3',
      async () => {
        const { turn, messageId } = await ask('Brainstorm ways to grow RKMD signups.');
        const task = (await tasks.execute(
          turn,
          start({
            title: 'Ways to grow RKMD signups',
            doneWhen: 'A top 3 of signup ideas with reasons.',
            agent: 'growth-analyst',
            client: 'rkmd',
            cardType: 'brainstorm',
            estimateMinutes: 30,
          }),
          messageId,
        )) as { id: string };
        const work = await cardTurn(task.id);
        const owner = (
          await createAgentBinding({
            knownTools: Object.keys(toolDefinitions),
            namespaces,
            card: cards.cardFor,
            wallRecords: cards.wallRecords,
            root,
            skills: { root: skillsRoot },
          }).bind({ threadId: work.threadId, sessionId: task.id })
        ).agent;
        assert.ok(owner?.tools.includes('brainstorm'));
        const hooks = cards.brainstorm(work);
        const finish = (fields: Record<string, unknown>) =>
          tasks.execute(work, { action: 'finish', id: task.id, status: 'done', ...fields }, null);
        const top = [
          { idea: 'Landing page for each Taboola audience', reason: 'Cheapest lift.' },
          { idea: 'Retarget GA4 drop-offs', reason: 'Warm traffic converts.' },
          { idea: 'Signup offer test', reason: 'Fast to learn.' },
        ];
        const card = {
          conclusion: 'Three ideas survived the critique.',
          evidence: ['Round 3 critique'],
          nextAction: 'Start the landing page card.',
          confidence: 'medium',
        };
        await assert.rejects(finish({ card: { ...card, top } }), /brainstorm.*rounds/i);
        await assert.rejects(
          hooks.begin({ participants: ['seo-analyst', 'copywriter'] }),
          /3 to 5/,
        );
        await assert.rejects(
          hooks.begin({ participants: ['seo-analyst', 'copywriter', 'growth-analyst'] }),
          /growth-analyst/,
        );
        await assert.rejects(
          hooks.begin({ participants: ['seo-analyst', 'copywriter', 'router'] }),
          /router/,
        );
        await assert.rejects(
          hooks.begin({
            participants: ['seo-analyst', 'copywriter', 'seo-analyst'],
          }),
          /3 to 5/,
        );
        await assert.rejects(
          hooks.begin({ participants: ['seo-analyst', 'copywriter', 'brand-strategist'] }),
          /brand-strategist/,
        );
        await assert.rejects(
          hooks.begin({
            participants: ['seo-analyst', 'copywriter', 'paid-analyst'],
            devilsAdvocate: 'growth-analyst',
          }),
          /devil/i,
        );
        const plan = await hooks.begin({
          participants: ['seo-analyst', 'copywriter', 'paid-analyst'],
        });
        await assert.rejects(
          hooks.begin({ participants: ['seo-analyst', 'copywriter', 'paid-analyst'] }),
          /already running/,
        );
        assert.match(plan.topic, /Ways to grow RKMD signups/);
        assert.match(plan.topic, /A top 3 of signup ideas with reasons\./);
        assert.equal(plan.devilsAdvocate, 'paid-analyst');
        assert.deepEqual(
          plan.participants.map((agent) => agent.name),
          ['seo-analyst', 'copywriter', 'paid-analyst'],
        );
        const seo = plan.participants[0]!;
        assert.match(seo.instructions, /Look for organic search wins\./);
        assert.match(
          seo.instructions,
          /Compare the client's ranking keywords with three competitors\./,
        );
        assert.deepEqual(seo.tools, ['browser']);
        assert.doesNotMatch(plan.participants[1]!.instructions, /keyword/);
        const entries = (text: string) =>
          ['seo-analyst', 'copywriter', 'paid-analyst'].map((agent) => ({ agent, text }));
        await assert.rejects(
          hooks.save([
            { round: 'ideas', entries: entries('Ideas.') },
            { round: 'build', entries: entries('Built.') },
          ]),
          /round/i,
        );
        await assert.rejects(finish({ card: { ...card, top } }), /brainstorm.*rounds/i);
        await hooks.save([
          { round: 'ideas', entries: entries('Ideas.') },
          { round: 'build', entries: entries('Built.') },
          { round: 'devil', entries: [{ agent: 'paid-analyst', text: 'Critique.' }] },
        ]);
        await assert.rejects(
          hooks.begin({ participants: ['seo-analyst', 'copywriter', 'paid-analyst'] }),
          /already ran/,
        );
        await assert.rejects(finish({ card }), /top/);
        await assert.rejects(finish({ card: { ...card, top: top.slice(0, 2) } }), /top/);
        await assert.rejects(
          finish({ card: { ...card, top: [...top.slice(0, 2), { idea: 'Blog', reason: '' }] } }),
          /top/,
        );
        const closed = (await finish({ card: { ...card, top } })) as { result?: string };
        const saved = (await db.pool.query('SELECT result FROM tasks WHERE id=$1', [task.id]))
          .rows[0]!.result as string;
        assert.ok(saved.includes('Retarget GA4 drop-offs'));
        assert.ok(saved.indexOf('Landing page') < saved.indexOf('Signup offer test'));
        assert.ok(closed);
      },
    );

    await t.test(
      'only a brainstorm card closes with a top 3 or runs brainstorm rounds',
      async () => {
        const { turn, messageId } = await ask('Check RKMD paid search.');
        const task = (await tasks.execute(
          turn,
          start({ agent: 'growth-analyst', client: 'rkmd', estimateMinutes: 20 }),
          messageId,
        )) as { id: string };
        const work = await cardTurn(task.id);
        await assert.rejects(
          cards
            .brainstorm(work)
            .begin({ participants: ['seo-analyst', 'copywriter', 'paid-analyst'] }),
          /brainstorm card/,
        );
        await assert.rejects(
          tasks.execute(
            work,
            {
              action: 'finish',
              id: task.id,
              status: 'done',
              card: {
                conclusion: 'Budget was capped.',
                evidence: ['Google Ads change log'],
                nextAction: 'Raise the cap.',
                confidence: 'high',
                top: [{ idea: 'Raise the cap', reason: 'It was capped.' }],
              },
            },
            null,
          ),
          /top/,
        );
      },
    );

    const pmRuns = async () =>
      (
        await db.pool.query<{ id: string; prompt: string; turn_id: string }>(
          `SELECT r.id,u.prompt,u.id AS turn_id FROM agent_pm_runs r JOIN turns u ON u.session_id=r.id
           ORDER BY r.created_at,u.created_at`,
        )
      ).rows;
    const pmTurn = async () => {
      const [run] = (await pmRuns()).slice(-1);
      return { run: run!, turn: await running(run!.turn_id) };
    };
    const settle = (turnId: string) =>
      db.pool.query("UPDATE turns SET status='succeeded',finished_at=now() WHERE id=$1", [turnId]);

    await t.test('the PM scan makes no model request when nothing is flagged', async () => {
      await db.pool.query("UPDATE tasks SET state='cancelled',closed_at=now() WHERE state='open'");
      await db.pool.query(
        "UPDATE turns SET status='cancelled',finished_at=now() WHERE status IN ('queued','running','waiting')",
      );
      const { task } = await routerCard('Check the RKMD Taboola pacing.', { estimateMinutes: 10 });
      await cardTurn(task.id);
      const before = (await db.pool.query('SELECT count(*)::int AS n FROM turns')).rows[0].n;
      assert.deepEqual((await pm.scan()).flags, []);
      assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM turns')).rows[0].n, before);
      assert.equal((await pmRuns()).length, 0);
    });

    await t.test(
      'flagged cards start one PM turn, which acts only on them with card actions that are recorded on the card',
      async () => {
        const [stalled] = (
          await db.pool.query<{ id: string; session_id: string }>(
            "SELECT id,session_id FROM tasks WHERE state='open'",
          )
        ).rows;
        const work = (
          await db.pool.query<{ id: string }>(
            "SELECT id FROM turns WHERE session_id=$1 AND status='running'",
            [stalled!.session_id],
          )
        ).rows[0]!.id;
        await db.pool.query("UPDATE turns SET started_at=now()-interval '25 minutes' WHERE id=$1", [
          work,
        ]);
        for (let call = 0; call < 4; call++)
          await pm.recordCall(work, 'browser', { ref: 'e12', action: 'click' });
        await pm.recordCall(work, 'browser', { action: 'click', ref: 'e13' });
        await db.pool.query(
          'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd) VALUES($1,$2,$3,4.5)',
          [randomUUID(), ownerId, work],
        );
        const { task: quiet } = await routerCard('Draft the Formulaic newsletter.', {
          estimateMinutes: 60,
        });
        await cardTurn(quiet.id);
        const { task: abandoned } = await routerCard('Audit the Krowdit pricing page.', {
          estimateMinutes: 60,
        });
        await db.pool.query(
          "UPDATE turns SET status='succeeded',started_at=now()-interval '21 minutes',finished_at=now()-interval '20 minutes' WHERE id=$1",
          [(await cardTurn(abandoned.id)).turnId],
        );
        const scanned = await pm.scan();
        assert.deepEqual(
          scanned.flags
            .map((flag) => `${flag.taskId === stalled!.id ? 'stalled' : 'abandoned'}:${flag.kind}`)
            .sort(),
          ['abandoned:unfinished', 'stalled:loop', 'stalled:over_budget', 'stalled:stalled'],
        );
        const runs = await pmRuns();
        assert.equal(runs.length, 1);
        assert.match(runs[0]!.prompt, new RegExp(`${stalled!.id}[\\s\\S]*Stalled[\\s\\S]*Looping`));
        assert.doesNotMatch(runs[0]!.prompt, new RegExp(quiet.id));
        assert.deepEqual((await pm.scan()).flags, []);
        assert.equal((await pmRuns()).length, 1);

        const binding = createAgentBinding({
          knownTools: Object.keys(toolDefinitions),
          namespaces,
          card: cards.cardFor,
          wallRecords: cards.wallRecords,
          pmSession: pm.isPmSession,
          root,
        });
        const { run, turn } = await pmTurn();
        const bound = (await binding.bind({ threadId: turn.threadId, sessionId: run.id })).agent;
        assert.equal(bound?.name, 'pm');
        assert.deepEqual(bound?.tools, ['task']);
        assert.match(bound?.instructions ?? '', /Keep every card moving\.[\s\S]*task nudge/);
        assert.match(bound?.instructions ?? '', /copywriter/);
        const chat = bindAgent(registry, { threadId: turn.threadId, sessionId: turn.threadId });
        assert.doesNotMatch(chat.agent?.instructions ?? '', /- pm, PM/);

        await assert.rejects(
          pm.act(turn, start({ agent: 'copywriter', estimateMinutes: 5 })),
          /only acts on cards/,
        );
        await assert.rejects(
          pm.act(turn, { action: 'finish', id: stalled!.id, status: 'done', result: 'Done.' }),
          /only acts on cards/,
        );
        assert.equal(await pm.act(turn, { action: 'list' }), undefined);
        await assert.rejects(
          pm.act(turn, { action: 'nudge', id: quiet.id, message: 'Hurry up.' }),
          /not flagged/,
        );
        await assert.rejects(
          pm.act(await cardTurn(quiet.id), {
            action: 'nudge',
            id: stalled!.id,
            message: 'Hurry up.',
          }),
          /Only the PM/,
        );
        await pm.act(turn, {
          action: 'nudge',
          id: stalled!.id,
          message: 'Stop clicking e12; read the pacing report instead.',
        });
        assert.match((await resumes(stalled!.id)).at(-1)!, /PM[\s\S]*Stop clicking e12/);
        await assert.rejects(
          pm.act(turn, { action: 'reassign', id: stalled!.id, agent: 'pm', reason: 'Mine.' }),
          /copywriter/,
        );
        await pm.act(turn, {
          action: 'reassign',
          id: stalled!.id,
          agent: 'copywriter',
          reason: 'This is a writing task.',
        });
        assert.equal((await cards.cardFor(stalled!.id))?.agent, 'copywriter');
        assert.match((await resumes(stalled!.id)).at(-1)!, /reassigned[\s\S]*growth-analyst/);
        await pm.act(turn, {
          action: 'split',
          id: stalled!.id,
          reason: 'Pacing and copy are separate jobs.',
          cards: [
            {
              agent: 'growth-analyst',
              title: 'Pull the pacing numbers',
              doneWhen: 'Daily spend vs plan is known.',
              estimateMinutes: 10,
            },
          ],
        });
        assert.match(
          (await resumes(stalled!.id)).at(-1)!,
          /split[\s\S]*Pull the pacing numbers: agent growth-analyst/,
        );
        await pm.act(turn, {
          action: 'escalate',
          id: stalled!.id,
          question: 'Should RKMD pacing keep its Taboola cap this month?',
        });
        assert.ok(
          (
            await db.pool.query("SELECT 1 FROM messages WHERE role='assistant' AND text LIKE $1", [
              '%Should RKMD pacing keep its Taboola cap this month?%',
            ])
          ).rowCount,
        );
        const [card] = await cards.read([stalled!.id]);
        assert.deepEqual(
          card?.activity.map((entry) => `${entry.actor}:${entry.action}`),
          [
            'scan:flagged',
            'scan:flagged',
            'scan:flagged',
            'pm:nudge',
            'pm:reassign',
            'pm:split',
            'pm:escalate',
          ],
        );
        assert.match(card!.activity[4]!.detail, /growth-analyst to copywriter/);
        await settle(turn.turnId);
      },
    );

    await t.test('the PM makes the call on a stuck ask and the asking card continues', async () => {
      await db.pool.query("UPDATE tasks SET state='cancelled',closed_at=now() WHERE state='open'");
      const { task } = await routerCard('Explain the Formulaic refund spike.', {
        estimateMinutes: 60,
      });
      const work = await cardTurn(task.id);
      const asked = (await cards.act(work, {
        action: 'ask',
        id: task.id,
        agent: 'copywriter',
        question: 'Did the refund email change?',
      })) as { ask: string };
      await db.pool.query('UPDATE agent_card_asks SET flagged_at=now() WHERE id=$1', [asked.ask]);
      const scanned = await pm.scan();
      assert.deepEqual(
        scanned.flags.map((flag) => flag.kind),
        ['ask_over_cap'],
      );
      const { turn } = await pmTurn();
      await pm.act(turn, {
        action: 'decide',
        ask: asked.ask,
        decision: 'Treat the refund email as unchanged; check the billing page instead.',
      });
      assert.match((await resumes(task.id)).at(-1)!, /made the call[\s\S]*billing page/);
      assert.equal(
        (
          await db.pool.query(
            "SELECT 1 FROM turns WHERE session_id=$1 AND status IN ('queued','running','waiting')",
            [asked.ask],
          )
        ).rowCount,
        0,
      );
      const [card] = await cards.read([task.id]);
      assert.equal(card?.activity.at(-1)?.action, 'decide');
      await settle(turn.turnId);
    });

    await t.test('a flag comes back when the PM turn it went to failed', async () => {
      await db.pool.query("UPDATE tasks SET state='cancelled',closed_at=now() WHERE state='open'");
      const { task } = await routerCard('Review the RKMD landing page.', { estimateMinutes: 60 });
      await db.pool.query(
        "UPDATE turns SET status='succeeded',started_at=now()-interval '31 minutes',finished_at=now()-interval '30 minutes' WHERE id=$1",
        [(await cardTurn(task.id)).turnId],
      );
      assert.deepEqual(
        (await pm.scan()).flags.map((flag) => flag.kind),
        ['unfinished'],
      );
      const { turn } = await pmTurn();
      await db.pool.query("UPDATE turns SET status='failed',finished_at=now() WHERE id=$1", [
        turn.turnId,
      ]);
      assert.deepEqual(
        (await pm.scan()).flags.map((flag) => flag.kind),
        ['unfinished'],
      );
      const { turn: retry } = await pmTurn();
      await pm.act(retry, { action: 'nudge', id: task.id, message: 'Close it with a result.' });
      await settle(retry.turnId);
      assert.deepEqual((await pm.scan()).flags, []);
    });
  },
);

const skillFile = (name: string, body: string) => `---
name: ${name}
description: ${name} procedure for the fixture.
---

${body}
`;

const builtInSkills = {
  catalog: [{ name: 'research', description: 'Research a question.' }],
  read(name: string) {
    if (name !== 'research') throw new Error('Select a skill from the skill library.');
    return {
      name,
      file: 'SKILL.md',
      content: skillFile('research', 'Cite every source you used.'),
    };
  },
};

test("a card's required and card-type skills are in full in its first turn and listed in its activity", async () => {
  const root = await configRoot({
    'core/team.md': team('router'),
    'core/router.md': agentFile(['task', 'ask_user']),
    'growth/team.md': team('growth-analyst'),
    'growth/growth-analyst.md': `---
title: Growth Analyst
role: Finds why a client's growth metrics moved.
tools: [apps, send_message]
skills: [attribution, research]
cardSkills:
  investigation: [anomaly-triage]
  brainstorm: [idea-rounds]
---
Investigate metric changes with evidence.
`,
  });
  const skillsRoot = await configRoot({
    'attribution/SKILL.md': skillFile(
      'attribution',
      'Compare GA4 sessions with ad platform clicks.',
    ),
    'anomaly-triage/SKILL.md': skillFile('anomaly-triage', 'Rule out tracking breaks first.'),
    'idea-rounds/SKILL.md': skillFile('idea-rounds', 'Write ideas privately first.'),
  });
  try {
    const threadId = randomUUID();
    const sessionId: string = randomUUID();
    const oddSession: string = randomUUID();
    const binding = createAgentBinding({
      knownTools: ['task', 'ask_user', 'apps', 'send_message'],
      namespaces,
      card: async (id) =>
        [sessionId, oddSession].includes(id)
          ? {
              agent: 'growth-analyst',
              client: null,
              role: 'owner' as const,
              card_type: id === sessionId ? 'investigation' : 'constructor',
            }
          : undefined,
      wallRecords: async () => ({ sessionTurns: new Set(), clientCards: new Set() }),
      root,
      skills: { root: skillsRoot, library: builtInSkills },
    });
    const activity: Array<[string, string]> = [];
    const { agent } = await binding.bind({
      threadId,
      sessionId,
      emit: async (type, summary) => {
        activity.push([type, summary]);
      },
    });
    let checked = false;
    await runAs(agent, async (_tools, options) => {
      assert.match(options.systemPrompt, /Compare GA4 sessions with ad platform clicks\./);
      assert.match(options.systemPrompt, /Cite every source you used\./);
      assert.match(options.systemPrompt, /Rule out tracking breaks first\./);
      assert.doesNotMatch(options.systemPrompt, /Write ideas privately first\./);
      assert.match(
        options.compactInstructions?.systemPrompt ?? '',
        /Rule out tracking breaks first\./,
      );
      checked = true;
    });
    assert.ok(checked);
    assert.equal(activity.length, 1);
    assert.equal(activity[0]![0], 'step');
    for (const name of ['attribution', 'research', 'anomaly-triage'])
      assert.ok(activity[0]![1].includes(name));
    assert.ok(!activity[0]![1].includes('idea-rounds'));
    const untyped = await binding.bind({ threadId, sessionId: oddSession });
    assert.match(untyped.agent?.instructions ?? '', /Cite every source you used\./);
    assert.doesNotMatch(untyped.agent?.instructions ?? '', /Rule out tracking breaks first\./);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(skillsRoot, { recursive: true, force: true });
  }
});

test('an agent naming a skill that does not exist is rejected at load with the name, and its cards run fail-closed', async () => {
  const root = await configRoot({
    'core/team.md': team('router'),
    'core/router.md': agentFile(['task', 'ask_user']),
    'growth/team.md': team('growth-lead'),
    'growth/growth-lead.md': `---
title: Growth Lead
role: Owns growth outcomes for each client.
tools: [task]
skills: [research]
---
Lead the growth team.
`,
    'growth/growth-analyst.md': `---
title: Growth Analyst
role: Finds why a client's growth metrics moved.
tools: [apps]
cardSkills:
  investigation: [anomaly-triag]
---
Investigate metric changes with evidence.
`,
  });
  const logged = console.error;
  console.error = () => {};
  try {
    const sessionId = randomUUID();
    const binding = createAgentBinding({
      knownTools: ['task', 'ask_user', 'apps'],
      namespaces,
      card: async () => ({
        agent: 'growth-analyst',
        client: null,
        role: 'owner' as const,
        card_type: 'investigation',
      }),
      wallRecords: async () => ({ sessionTurns: new Set(), clientCards: new Set() }),
      root,
      skills: { root: join(root, 'no-skills'), library: builtInSkills },
    });
    const registry = (await binding.registry())!;
    assert.ok(registry.agents.has('growth-lead'));
    assert.ok(!registry.agents.has('growth-analyst'));
    assert.deepEqual(
      registry.problems.map((problem) => problem.path),
      ['growth/growth-analyst.md'],
    );
    assert.match(registry.problems[0]!.reason, /anomaly-triag/);
    const { agent } = await binding.bind({ threadId: randomUUID(), sessionId });
    assert.deepEqual(agent?.tools, ['task', 'ask_user', 'send_message']);
    assert.match(agent?.instructions ?? '', /missing or invalid/);
  } finally {
    console.error = logged;
    await rm(root, { recursive: true, force: true });
  }
});

const brainstormers = ['seo-analyst', 'paid-analyst', 'copywriter'].map((name) => ({
  name,
  title: `${name} agent`,
  tools: ['browser', 'send_message'],
  instructions: `Think as the ${name}. Marker ${name}.`,
}));

test("a brainstorm runs private ideas in parallel, a cross-build, one devil's advocate, each as its own agent, then leaves convergence to the owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-brainstorm-'));
  const threadId = randomUUID();
  const helpers: Array<{ who: string; prompt: string; system: string; tools: string[] }> = [];
  const saved: unknown[] = [];
  let started = 0;
  let allStarted!: () => void;
  const together = new Promise<void>((resolve) => (allStarted = resolve));
  let result: unknown;
  const context: RuntimeContext = {
    threadId,
    sessionId: randomUUID(),
    turnId: randomUUID(),
    prompt: 'Run the brainstorm on growing RKMD signups.',
    history: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async () => {},
    reply: async () => {},
    delta: () => {},
    publish: async () => {
      throw new Error('Not used');
    },
    requestCredential: async () => ({ url: '/credentials/fixture' }),
    integration: async () => ({}),
    manage: async () => ({}),
    agent: {
      name: 'growth-lead',
      title: 'Growth Lead',
      tools: ['apps', 'task', 'brainstorm'],
      instructions: 'Lead growth work. Marker growth-lead.',
    },
    brainstorm: {
      begin: async (input) => {
        assert.deepEqual(input, {
          participants: ['seo-analyst', 'paid-analyst', 'copywriter'],
          devilsAdvocate: 'copywriter',
        });
        return {
          topic: 'Ways to grow RKMD signups this quarter',
          participants: brainstormers,
          devilsAdvocate: 'copywriter',
        };
      },
      save: async (rounds) => {
        saved.push(rounds);
      },
    },
  };
  const session: Agent = {
    open: async (options) => ({
      resumed: false,
      prompt: async (text) => {
        if (!options.ephemeral) {
          const tool = options.tools.find((item) => item.name === 'brainstorm');
          assert.ok(tool);
          result = await options.runTool(
            'brainstorm',
            {
              participants: ['seo-analyst', 'paid-analyst', 'copywriter'],
              devilsAdvocate: 'copywriter',
            },
            () =>
              tool.execute({
                participants: ['seo-analyst', 'paid-analyst', 'copywriter'],
                devilsAdvocate: 'copywriter',
              }),
          );
          return;
        }
        const who = brainstormers.find((agent) =>
          options.systemPrompt.includes(`Marker ${agent.name}.`),
        )!.name;
        const round = helpers.filter((helper) => helper.who === who).length + 1;
        helpers.push({
          who,
          prompt: text,
          system: options.systemPrompt,
          tools: options.tools.map((tool) => tool.name).sort(),
        });
        if (helpers.length <= 3) {
          started += 1;
          if (started === 3) allStarted();
          await together;
        }
        options.onEvent({ type: 'final', text: `Answer ${round} from ${who}.` });
      },
      abort: () => {},
      dispose: () => {},
    }),
    dispose: () => {},
  };
  const runtime = createAgentRuntime({
    agent: session,
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
  });
  try {
    await runtime.runTurn(context);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(
    helpers.map((helper) => helper.who),
    [
      ...helpers.slice(0, 3).map((helper) => helper.who),
      ...helpers.slice(3, 6).map((helper) => helper.who),
      'copywriter',
    ],
  );
  assert.equal(helpers.length, 7);
  assert.deepEqual(
    new Set(helpers.slice(0, 3).map((helper) => helper.who)),
    new Set(brainstormers.map((agent) => agent.name)),
  );
  assert.deepEqual(
    new Set(helpers.slice(3, 6).map((helper) => helper.who)),
    new Set(brainstormers.map((agent) => agent.name)),
  );
  for (const helper of helpers) {
    assert.match(helper.system, new RegExp(`Marker ${helper.who}\\.`));
    for (const other of [...brainstormers.map((agent) => agent.name), 'growth-lead'])
      if (other !== helper.who)
        assert.doesNotMatch(helper.system, new RegExp(`Marker ${other}\\.`));
    assert.deepEqual(helper.tools, ['browser']);
    assert.match(helper.prompt, /Ways to grow RKMD signups this quarter/);
  }
  for (const helper of helpers.slice(0, 3)) assert.doesNotMatch(helper.prompt, /Answer \d from/);
  for (const helper of helpers.slice(3, 6))
    for (const agent of brainstormers)
      assert.ok(helper.prompt.includes(`Answer 1 from ${agent.name}.`));
  for (const agent of brainstormers)
    assert.ok(helpers[6]!.prompt.includes(`Answer 2 from ${agent.name}.`));
  assert.equal(saved.length, 1);
  const rounds = saved[0] as Array<{
    round: string;
    entries: Array<{ agent: string; text: string }>;
  }>;
  assert.deepEqual(
    rounds.map((round) => [round.round, round.entries.length]),
    [
      ['ideas', 3],
      ['build', 3],
      ['devil', 1],
    ],
  );
  assert.equal(rounds[2]!.entries[0]!.text, 'Answer 3 from copywriter.');
  assert.match(JSON.stringify(result), /top/);
});

test('the browser image runs Google Chrome on Linux x64 and says why it falls back to Chromium', async () => {
  const { containerBrowserProduct, googleChrome } =
    await import('../src/providers/container-browser/chrome.ts');
  const chrome = containerBrowserProduct('x64', (path) => path === googleChrome);
  assert.equal(chrome.product, 'Google Chrome');
  assert.match(chrome.executable, /chrome\.sh$/);
  assert.equal(chrome.reason, undefined);
  const arm = containerBrowserProduct('arm64', () => true);
  assert.equal(arm.product, 'Chromium');
  assert.ok(arm.reason);
  assert.equal(containerBrowserProduct('x64', () => false).product, 'Chromium');
});

test('the shipped roster loads every agent, team and client, with its skills and watchers, and no agent can send, reply or refund', async () => {
  const root = fileURLToPath(new URL('../agents/', import.meta.url));
  const registry = await loadAgentRegistry(root, Object.keys(toolDefinitions));
  const skills = loadAgentSkills({
    root: fileURLToPath(new URL('../agent-skills/', import.meta.url)),
  });
  rejectMissingSkills(registry, skills);
  assert.deepEqual(registry.problems, []);
  assert.deepEqual(
    Object.fromEntries([...registry.teams.values()].map((team) => [team.name, team.lead])),
    { core: 'router', creative: 'creative-lead', growth: 'growth-lead' },
  );
  assert.deepEqual([...registry.agents.keys()].sort(), [
    'ad-creative-maker',
    'chief-of-staff',
    'content-seo-analyst',
    'copywriter',
    'creative-lead',
    'ga4-analyst',
    'growth-lead',
    'inbox',
    'paid-media-analyst',
    'pm',
    'revenue-analyst',
    'router',
  ]);
  const owners = cardOwners(registry);
  assert.ok(owners.every((agent) => agent.team !== 'core'));
  for (const agent of owners) {
    assert.ok(agent.model && agent.budget?.cardUsd && agent.skills?.length, agent.name);
    const names = [...(agent.skills ?? []), ...Object.values(agent.cardSkills ?? {}).flat()];
    for (const name of names) assert.ok(skills.read(name).length > 200, `${agent.name}: ${name}`);
    const writes = agent.tools.filter(
      (tool) =>
        tool.startsWith('mcp__') &&
        /_(send|reply|forward|refund|archive|swap|retry|trash|delete)(_|$)/.test(tool),
    );
    assert.deepEqual(writes, [], agent.name);
  }
  assert.deepEqual([...registry.clients.keys()].sort(), ['formulaic', 'krowdit', 'rkmd']);
  for (const client of registry.clients.values()) {
    assert.equal(client.budget.monthlyUsd, 500, client.name);
    for (const [name, threshold] of Object.entries(client.thresholds ?? {})) {
      assert.ok(
        owners.some((agent) => agent.name === threshold.agent),
        `${client.name}.${name}`,
      );
      assert.equal(
        writeRefusal({ name: threshold.source.tool, inputSchema: {} }, threshold.source.tool),
        undefined,
      );
    }
    for (const inbox of client.inboxes ?? [])
      if (typeof inbox !== 'string')
        for (const tool of [inbox.tool, inbox.read ?? 'read'])
          assert.equal(writeRefusal({ name: tool, inputSchema: {} }, tool), undefined);
  }
  assert.deepEqual(Object.keys(registry.clients.get('rkmd')?.thresholds ?? {}).length > 0, true);
  assert.deepEqual(
    Object.keys(registry.clients.get('formulaic')?.thresholds ?? {}).length > 0,
    true,
  );
  assert.deepEqual(registry.clients.get('krowdit')?.inboxes, ['contact@crowdit.ai']);
  assert.equal(
    (registry.clients.get('formulaic')?.inboxes ?? []).filter((inbox) => typeof inbox !== 'string')
      .length,
    1,
  );
});
