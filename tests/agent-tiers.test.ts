import assert from 'node:assert/strict';
import test from 'node:test';
import { actionTier, tierRules } from '../src/server/agents/tiers.ts';

const tier = (action: string, args: Record<string, unknown> = {}) => actionTier(action, args)?.tier;

test('reads, research and drafts are Tier 1', () => {
  assert.equal(tier('GOOGLE_ANALYTICS_RUN_REPORT_GET'), 1);
  assert.equal(tier('mcp__krowdit__growth_meta_get_insights', { account: 'act_1' }), 1);
  assert.equal(tier('mcp__krowdit__mail_gmail_search', { query: 'refund' }), 1);
  assert.equal(tier('STRIPE_LIST_REFUNDS'), 1);
  assert.equal(tier('WORDPRESS_GET_POST', { id: 3 }), 1);
  assert.equal(tier('GMAIL_CREATE_EMAIL_DRAFT', { to: 'client@example.test' }), 1);
  assert.equal(tier('mcp__krowdit__instagram_research_page', { handle: 'synthetic' }), 1);
});

test('actions that only reduce spend are Tier 1', () => {
  assert.equal(tier('META_PAUSE_ADSET', { adset_id: '1' }), 1);
  assert.equal(tier('META_UPDATE_ADSET', { adset_id: '1', status: 'PAUSED' }), 1);
  assert.equal(tier('TABOOLA_UPDATE_CAMPAIGN', { id: '7', is_active: false }), 1);
});

test('raising spend, publishing, sending to people and deleting are Tier 2', () => {
  for (const [action, args] of [
    ['GMAIL_SEND_EMAIL', { to: 'client@example.test' }],
    ['mcp__krowdit__support_mail_gmail_reply', { thread: 't1' }],
    ['GMAIL_FORWARD_MESSAGE', { to: 'someone@example.test' }],
    ['WORDPRESS_PUBLISH_POST', { id: 3 }],
    ['INSTAGRAM_CREATE_POST', { caption: 'Synthetic launch' }],
    ['GMAIL_DELETE_MESSAGE', { id: 'm1' }],
    ['mcp__krowdit__refund_stripe_create_refund', { charge: 'ch_1' }],
    ['META_UPDATE_ADSET', { adset_id: '1', daily_budget: 9000 }],
    ['META_UPDATE_ADSET', { adset_id: '1', status: 'ACTIVE' }],
    ['META_RESUME_CAMPAIGN', { id: '1' }],
    ['GOOGLE_ADS_UPDATE_BID', { keyword: 'k', bid: 2 }],
    ['TABOOLA_UPDATE_CAMPAIGN', { id: '7', daily_budget: '$50' }],
    ['META_UPDATE_ADSET', { id: '7', budget: { amount: 50 } }],
    ['TABOOLA_UPDATE_CAMPAIGN', { id: '7', is_active: true }],
    ['META_UPDATE_CAMPAIGN', { id: '7', status: 'ARCHIVED' }],
    ['GMAIL_FETCH_AND_DELETE', { id: 'm1' }],
  ] as const)
    assert.equal(tier(action, args), 2, action);
});

test('a budget change is Tier 2 even when it looks like a reduction, since its direction is unknown', () => {
  assert.equal(tier('META_PAUSE_ADSET', { adset_id: '1', daily_budget: 10 }), 2);
  assert.match(actionTier('META_UPDATE_ADSET', { lifetime_budget: 1 })!.reason, /budget/);
});

test('an action the policy cannot place is left to the trust check and the tier rules', () => {
  assert.equal(tier('NOD_browser', { step: 'click', control: [{ name: 'Publish' }] }), undefined);
  assert.equal(tier('WORDPRESS_UPDATE_PAGE', { id: 3, title: 'New' }), undefined);
});

test('tier rules name the agent, the client and its accounts, and ask first for Tier 2', () => {
  const rules = tierRules(
    { name: 'paid-media', title: 'Paid Media Analyst' },
    {
      name: 'formulaic',
      title: 'Formulaic',
      connections: [{ service: 'meta', account: 'ads@formulaic.example' }],
    },
  );
  assert.match(rules, /Paid Media Analyst/);
  assert.match(rules, /Formulaic/);
  assert.match(rules, /meta ads@formulaic\.example/);
});

test(
  'on a card, Tier 2 always asks, waits in the queue without notifying unless urgent, and Tier 1 runs on the tier rules',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 },
  async (t) => {
    const { randomUUID } = await import('node:crypto');
    const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { dirname, join } = await import('node:path');
    const pg = (await import('pg')).default;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_tiers_${suffix}`;
    const bossSchema = `test_tiers_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const root = await mkdtemp(join(tmpdir(), 'nod-tiers-'));
    const files: Record<string, string> = {
      'core/team.md': '---\nlead: router\nrouting: Routes requests.\n---\n',
      'core/router.md': '---\ntitle: Router\nrole: Routes.\ntools: [task]\n---\nRoute.\n',
      'growth/team.md': '---\nlead: paid-media\nrouting: Owns paid media.\n---\n',
      'growth/paid-media.md':
        '---\ntitle: Paid Media Analyst\nrole: Runs paid media.\ntools: [apps]\n---\nManage ads.\n',
      'clients/formulaic.md':
        '---\ntitle: Formulaic\nbudget:\n  monthlyUsd: 500\nconnections:\n  - service: meta\n    account: ads@formulaic.example\n---\nSynthetic brief.\n',
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createTasks } = await import('../src/server/tasks.ts');
    const { createCards } = await import('../src/server/agents/cards.ts');
    const { createTierQueue } = await import('../src/server/agents/tier-queue.ts');
    const { loadAgentRegistry } = await import('../src/server/agents/registry.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createTrust } = await import('../src/server/trust.ts');
    const { createApprovals } = await import('../src/server/approvals.ts');
    const { appConfirmation } = await import('../src/ports/agent.ts');
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
    const queue = createTierQueue({ pool: db.pool, ownerId, registry: async () => registry });
    const tasks = createTasks({
      pool: db.pool,
      ownerId,
      cards: cards.hooks,
      approvalNote: queue.note,
    });
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
    await queue.initialize();
    const reviewed: Array<{ userRules?: unknown }> = [];
    const trust = createTrust({
      pool: db.pool,
      ownerId,
      tiers: queue.trust,
      review: async (_instructions, input) => {
        reviewed.push(input as { userRules?: unknown });
        return { terms: [], run: true, because: 'Go ahead without asking' };
      },
    });
    const ran: string[] = [];
    const approvals = await createApprovals(
      async (action) => {
        ran.push(action);
        return { ok: true };
      },
      undefined,
      undefined,
      async (proposal) => ({ question: `Can I run ${proposal.action}?`, action: 'Run it' }),
      undefined,
      queue.asked,
    );
    const running = async (turnId: string) => {
      await db.pool.query("UPDATE turns SET status='running',started_at=now() WHERE id=$1", [
        turnId,
      ]);
      return { threadId: (await thread.activeThread()).id, turnId };
    };
    const card = async (title: string) => {
      const submitted = await thread.submitUserMessage(`${title} for Formulaic.`);
      const router = await running(submitted.turnId);
      const task = (await tasks.execute(
        router,
        {
          action: 'start',
          title,
          doneWhen: 'Done.',
          now: 'Starting.',
          message: 'The Paid Media Analyst has this.',
          agent: 'paid-media',
          client: 'formulaic',
          estimateMinutes: 20,
        },
        submitted.messageId,
      )) as { id: string };
      await db.pool.query("UPDATE turns SET status='succeeded',finished_at=now() WHERE id=$1", [
        router.turnId,
      ]);
      const work = await running(
        (
          await db.pool.query<{ id: string }>(
            'SELECT id FROM turns WHERE session_id=$1 ORDER BY created_at LIMIT 1',
            [task.id],
          )
        ).rows[0]!.id,
      );
      await tasks.inherit(work);
      return { task, work, router };
    };
    const outcome = async (
      turn: { threadId: string; turnId: string },
      action: string,
      args: Record<string, unknown>,
    ) => {
      const verdict = await trust.check(turn, action, args);
      return verdict.confirm
        ? approvals.request(turn, action, args)
        : approvals.request(turn, action, args, { allowed: true, basis: verdict.basis });
    };

    await t.test('a card turn sees the tier rules and runs a spend reduction on them', async () => {
      const { work } = await card('Pause the losing ad set');
      const result = await outcome(work, 'META_PAUSE_ADSET', { adset_id: 'synthetic-1' });
      assert.deepEqual(result, { ok: true });
      assert.deepEqual(ran, ['META_PAUSE_ADSET']);
      assert.match(
        String(reviewed.at(-1)?.userRules),
        /Paid Media Analyst agent working on a Formulaic card/,
      );
      assert.deepEqual(await queue.list(), []);
    });

    await t.test('Tier 2 asks the owner even when the trust check would run it', async () => {
      reviewed.length = 0;
      ran.length = 0;
      const { work, task } = await card('Email the client the weekly numbers');
      await tasks.execute(
        work,
        {
          action: 'update',
          id: task.id,
          approval: {
            why: 'The client asked for the numbers.',
            ifWaiting: 'They get them tomorrow.',
          },
        },
        null,
      );
      const verdict = await trust.check(work, 'GMAIL_SEND_EMAIL', { to: 'client@example.test' });
      assert.equal(verdict.confirm, true);
      assert.equal(verdict.confirm && verdict.reason, 'rule');
      assert.equal(reviewed.length, 0);
      const result = await approvals.request(work, 'GMAIL_SEND_EMAIL', {
        to: 'client@example.test',
      });
      assert.ok(result && typeof result === 'object' && appConfirmation in result);
      assert.deepEqual(ran, []);
      const [item] = await queue.list();
      assert.equal(item?.client, 'formulaic');
      assert.equal(item?.agentTitle, 'Paid Media Analyst');
      assert.equal(item?.action, 'GMAIL_SEND_EMAIL');
      assert.deepEqual(item?.args, { to: 'client@example.test' });
      assert.equal(item?.why, 'The client asked for the numbers.');
      assert.equal(item?.ifWaiting, 'They get them tomorrow.');
      assert.equal(item?.urgent, null);
      assert.deepEqual(await queue.held([item!.messageId]), [item!.messageId]);
      const text = (await db.pool.query('SELECT text FROM messages WHERE id=$1', [item!.messageId]))
        .rows[0].text as string;
      assert.equal(text, 'Can I run GMAIL_SEND_EMAIL?');
    });

    await t.test('an urgent Tier 2 item is queued but not held back from notifying', async () => {
      const { work, task } = await card('Refund the double charge');
      await tasks.execute(
        work,
        {
          action: 'update',
          id: task.id,
          approval: {
            why: 'A customer was charged twice.',
            ifWaiting: 'The customer disputes the charge overnight.',
            urgent: 'The dispute window closes tonight.',
          },
        },
        null,
      );
      await outcome(work, 'mcp__krowdit__refund_stripe_create_refund', { charge: 'ch_synthetic' });
      const urgent = (await queue.list()).find((item) => item.urgent);
      assert.equal(urgent?.urgent, 'The dispute window closes tonight.');
      assert.equal((await queue.list())[0]?.approvalId, urgent?.approvalId);
      assert.equal((await queue.held([urgent!.messageId])).includes(urgent!.messageId), false);
      assert.deepEqual(ran, []);
    });

    await t.test(
      'work outside a card gets no tier rules and keeps upstream behaviour',
      async () => {
        reviewed.length = 0;
        const submitted = await thread.submitUserMessage('Send the synthetic report to Bob.');
        const turn = await running(submitted.turnId);
        await trust.check(turn, 'GMAIL_SEND_EMAIL', { to: 'bob@example.test' });
        assert.equal(reviewed.length, 1);
        assert.equal(reviewed[0]?.userRules, undefined);
        await assert.rejects(
          tasks.execute(
            turn,
            { action: 'update', id: randomUUID(), approval: { why: 'x', ifWaiting: 'y' } },
            null,
          ),
        );
      },
    );
  },
);
