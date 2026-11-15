import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Agent, AgentSessionOptions, AgentTool, RuntimeContext } from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { mcpNamespaces, toolDefinitions } from '../src/runtime/tools.ts';
import { bindAgent, createAgentBinding, loadAgentRegistry } from '../src/server/agents/registry.ts';
import { wallCard } from '../src/server/agents/clients.ts';
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
    card: async () => ({ agent: 'growth-analyst', client: 'rkmd', role: 'owner' as const }),
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
      },
    );
    assert.deepEqual(
      walled.connectedApps?.map((item) => item.connectionId),
      ['rkmd-ga4'],
    );
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
    assert.match(outcomes[7]!, /Saved logins belong to the owner/);
    assert.match(outcomes[8]!, /computer holds every client's files/);
    assert.equal(walled.learnedSkills, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      'growth/team.md': `---
lead: growth-analyst
routing: Owns client growth metrics, traffic and conversion questions.
---
`,
      'growth/growth-analyst.md': analyst,
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
    });
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createTasks } = await import('../src/server/tasks.ts');
    const { createCards } = await import('../src/server/agents/cards.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { ownerId } = await import('../src/server/config.ts');
    t.after(async () => {
      await thread.stopThreadWorkers();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    });
    const registry = await loadAgentRegistry(root);
    assert.deepEqual(registry.problems, []);
    const cards = createCards({ pool: db.pool, ownerId, registry: async () => registry });
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
        await cards.recordAction({
          taskId: lead.id,
          actor: 'pm',
          action: 'nudge',
          reason: 'The card passed its estimate.',
        });

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
  },
);
