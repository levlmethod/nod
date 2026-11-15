import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Agent, AgentSessionOptions, AgentTool, RuntimeContext } from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { toolDefinitions } from '../src/runtime/tools.ts';
import { bindAgent, createAgentBinding, loadAgentRegistry } from '../src/server/agents/registry.ts';
import { scanBoard, type CardSnapshot } from '../src/server/agents/pm-scan.ts';
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
    cardAgent: async () => 'growth-analyst',
    root: '',
  });
  assert.deepEqual(await binding.bind({ threadId, sessionId: threadId }), {});
  assert.deepEqual(await binding.bind({ threadId, sessionId: randomUUID() }), {});
  assert.equal(await binding.registry(), undefined);
});

async function runAs(
  agent: RuntimeContext['agent'],
  run: (tools: Map<string, AgentTool>, options: AgentSessionOptions) => Promise<void>,
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
        tasks.execute(turn, start({ agent: 'growth-analyst' }), messageId),
        /estimateMinutes/,
      );
      assert.equal((await db.pool.query('SELECT 1 FROM tasks')).rowCount, 0);
      const chat = bindAgent(registry, { threadId: turn.threadId, sessionId: turn.threadId });
      assert.match(chat.agent?.instructions ?? '', /growth-analyst, Growth Analyst/);
      assert.match(chat.agent?.instructions ?? '', /Owns client growth metrics/);
    });

    await t.test('a started card records its owner agent and runs as that agent', async () => {
      const { turn, messageId } = await ask('Find out why RKMD conversions dropped.');
      const task = (await tasks.execute(
        turn,
        start({ agent: 'growth-analyst', estimateMinutes: 45, cardType: 'investigation' }),
        messageId,
      )) as { id: string };
      const row = (await db.pool.query('SELECT * FROM agent_cards WHERE task_id=$1', [task.id]))
        .rows[0];
      assert.equal(row.agent, 'growth-analyst');
      assert.equal(row.card_type, 'investigation');
      assert.equal(row.estimate_minutes, 45);
      assert.equal(Number(row.budget_usd), 4);
      assert.equal(await cards.agentFor(task.id), 'growth-analyst');
      const bound = bindAgent(
        registry,
        { threadId: turn.threadId, sessionId: task.id },
        await cards.agentFor(task.id),
      ).agent;
      assert.equal(bound?.name, 'growth-analyst');
      assert.deepEqual(bound?.tools, ['browser', 'apps', 'send_message', 'task']);
      assert.match(bound?.instructions ?? '', /Investigate metric changes with evidence\./);
      assert.match(bound?.instructions ?? '', /conclusion, evidence/);
      const binding = createAgentBinding({
        knownTools: [],
        cardAgent: cards.agentFor,
        root,
      });
      assert.equal(
        (await binding.bind({ threadId: turn.threadId, sessionId: task.id })).agent?.name,
        'growth-analyst',
      );
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
        start({ agent: 'growth-analyst', estimateMinutes: 20 }),
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
        assert.equal(await off.agentFor(task.id), undefined);
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
        start({ agent: 'growth-analyst', estimateMinutes: 15 }),
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
        start({ agent: 'growth-analyst', estimateMinutes: 30, ...fields }),
        messageId,
      )) as { id: string };
      return { turn, task };
    };

    await t.test('a card agent splits its card into child cards for other agents', async () => {
      const { task: parent } = await routerCard('Plan the Formulaic spring campaign.');
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
      assert.equal(await cards.agentFor(child.id), 'copywriter');
      assert.equal(await cards.agentFor(parent.id), 'growth-analyst');
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
          start({ agent: 'copywriter', estimateMinutes: 10, blockedBy: [randomUUID()] }),
          unknown.messageId,
        ),
        /not a card/,
      );
      const { turn: chat, messageId } = await ask('Write the RKMD weekly summary after that.');
      const second = (await tasks.execute(
        chat,
        start({ agent: 'copywriter', estimateMinutes: 10, blockedBy: [first.id] }),
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
        start({ agent: 'copywriter', estimateMinutes: 10, blockedBy: [third.id] }),
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
        const { task } = await routerCard('Find why Formulaic refunds rose.');
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
          assert.equal(await cards.askedAgentFor(asked.ask), 'copywriter');
          const binding = createAgentBinding({
            knownTools: Object.keys(toolDefinitions),
            cardAgent: cards.agentFor,
            askedAgent: cards.askedAgentFor,
            root,
          });
          const bound = (await binding.bind({ threadId: answering.threadId, sessionId: asked.ask }))
            .agent;
          assert.equal(bound?.name, 'copywriter');
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
          cardAgent: cards.agentFor,
          askedAgent: cards.askedAgentFor,
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
        assert.equal(await cards.agentFor(stalled!.id), 'copywriter');
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
            'pm:flagged',
            'pm:flagged',
            'pm:flagged',
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
      await assert.rejects(
        cards.act(
          await running(
            (
              await db.pool.query<{ id: string }>(
                "SELECT id FROM turns WHERE session_id=$1 AND status='queued' LIMIT 1",
                [asked.ask],
              )
            ).rows[0]!.id,
          ),
          { action: 'answer', id: asked.ask, answer: 'Late answer.' },
        ),
        /no question/,
      );
      const [card] = await cards.read([task.id]);
      assert.equal(card?.activity.at(-1)?.action, 'decide');
      await settle(turn.turnId);
    });
  },
);
