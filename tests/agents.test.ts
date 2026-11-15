import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Agent, AgentSessionOptions, AgentTool, RuntimeContext } from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { bindAgent, createAgentBinding, loadAgentRegistry } from '../src/server/agents/registry.ts';
import { wallCard } from '../src/server/agents/clients.ts';
import { mcpNamespaces } from '../src/runtime/tools.ts';

const namespaces = (servers: NonNullable<RuntimeContext['mcpServers']>) =>
  mcpNamespaces(servers).map(({ namespace }) => namespace);
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

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
    card: async () => ({ agent: 'growth-analyst', client: 'rkmd' }),
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
      assert.deepEqual(await cards.cardFor(task.id), { agent: 'growth-analyst', client: 'rkmd' });
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
  },
);
