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
      cardAgent: async () => undefined,
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
      assert.equal(await cards.typeFor(task.id), 'investigation');
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
            cardType: 'brainstorm',
            estimateMinutes: 30,
          }),
          messageId,
        )) as { id: string };
        const work = await cardTurn(task.id);
        const owner = (
          await createAgentBinding({
            knownTools: Object.keys(toolDefinitions),
            cardAgent: cards.agentFor,
            cardType: cards.typeFor,
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
          start({ agent: 'growth-analyst', estimateMinutes: 20 }),
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
      cardAgent: async (id) =>
        [sessionId, oddSession].includes(id) ? 'growth-analyst' : undefined,
      cardType: async (id) => (id === sessionId ? 'investigation' : 'constructor'),
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
      cardAgent: async () => 'growth-analyst',
      cardType: async () => 'investigation',
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
