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
      'core/chief-of-staff.md':
        '---\ntitle: Chief of Staff\nrole: Writes the digest.\ntools: []\n---\nReport.\n',
      'clients/rkmd.md': '---\ntitle: RKMD\nbudget:\n  monthlyUsd: 300\n---\nSynthetic brief.\n',
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
      async (reply) =>
        /^yes$/i.test(reply.trim()) ? true : /^no$/i.test(reply.trim()) ? false : undefined,
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
    const card = async (title: string, extra: Record<string, unknown> = {}) => {
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
          ...extra,
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

    await t.test(
      'the morning digest leads with the queue, reports from board, queue and usage records, and a Telegram reply answers the bound approval',
      async () => {
        const { createLedger } = await import('../src/server/ledger.ts');
        const { createClientBudget } = await import('../src/server/agents/client-budget.ts');
        const { createBoard } = await import('../src/server/agents/board.ts');
        const { createWatchers } = await import('../src/server/agents/watchers.ts');
        const { createDigest } = await import('../src/server/agents/digest.ts');
        const { createChannels } = await import('../src/server/channels.ts');
        const { transaction } = await import('../src/server/transaction.ts');
        await createLedger({ pool: db.pool, ownerId }).initialize();
        const budget = createClientBudget({
          pool: db.pool,
          ownerId,
          registry: async () => registry,
        });
        await budget.initialize();
        await createWatchers({
          pool: db.pool,
          ownerId,
          registry: async () => registry,
          servers: async () => [],
          call: async () => ({}),
        } as never).initialize();
        const board = createBoard({
          pool: db.pool,
          ownerId,
          registry: async () => registry,
          cards,
          spend: budget.spend,
        });
        const digest = createDigest({
          pool: db.pool,
          ownerId,
          registry: async () => registry,
          board,
          queue,
        });
        await digest.initialize();
        const threadId = (await thread.activeThread()).id;
        const posts: Array<{ text: string; replyToMessageId?: string }> = [];
        let incoming: import('../src/ports/messaging.ts').InboundMessage[] = [];
        const answered: unknown[] = [];
        const channels = await createChannels(db.pool, {
          ownerId,
          transport: {
            channels: [
              {
                id: 'telegram',
                status: 'configured',
                missing: [],
                accountId: 'bot',
                allowedSenderIds: ['111'],
              },
            ],
            poll: async (accept) => {
              const batch = incoming;
              incoming = [];
              for (const message of batch) await accept(message);
            },
            receive: async () => ({ status: 200, body: {} }),
            post: async (input) => {
              posts.push({
                text: input.text,
                ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
              });
              return { id: `provider-${posts.length}`, ids: [`provider-${posts.length}`] };
            },
            close: async () => {},
          },
          subscribe: () => () => {},
          intervalMs: 600000,
          answer: (text, channel, replyToMessageId) =>
            approvals.chat.answer({ text, channel, threadId, replyToMessageId }),
          submit: async (text, sourceId, client, channel, messageId, answer, replyToMessageId) => {
            answered.push(answer);
            if (answer)
              return (
                (await approvals.chat.accept(client, {
                  text,
                  channel,
                  threadId,
                  sourceId,
                  clientMessageId: messageId,
                  answer,
                  ...(replyToMessageId ? { replyToMessageId } : {}),
                })) as { turnId: string }
              ).turnId;
            const turnId = randomUUID();
            await client.query(
              `INSERT INTO turns(id,owner_id,thread_id,session_id,source,source_id,channel,prompt,status)
               VALUES($1,$2,$3,$3,'user',$4,$5,$6,'succeeded')`,
              [turnId, ownerId, threadId, sourceId, channel, text],
            );
            return turnId;
          },
        });
        t.after(() => channels.close());
        const say = (messageId: string, text: string, replyToMessageId?: string) => {
          incoming.push({
            channelId: 'telegram',
            accountId: 'bot',
            senderId: '111',
            messageId,
            threadId: 'chat-111',
            text,
            ...(replyToMessageId ? { replyToMessageId } : {}),
            sentAt: new Date(),
          });
          return channels.drain();
        };
        await say('hello', 'Good night.');

        const finish = (
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
                nextAction: 'Keep the budget.',
                confidence: 'high',
              },
            },
            null,
          );
        const done = await card('Report last week ROAS');
        await finish(done.work, done.task.id, 'ROAS held at 2.4.');
        const old = await card('Old audit');
        await finish(old.work, old.task.id, 'Audit done.');
        await db.pool.query("UPDATE tasks SET closed_at=now()-interval '3 days' WHERE id=$1", [
          old.task.id,
        ]);
        const plan = await card('Plan the launch');
        const blocked = await card('Write the launch email', { blockedBy: [plan.task.id] });
        const escalated = await card('Move spend to Taboola');
        const anomaly = await card('Investigate the ROAS drop');
        const recording = await db.pool.connect();
        try {
          await cards.record(recording, escalated.task.id, {
            actor: 'pm',
            action: 'escalate',
            detail: 'Should Formulaic move $200 from Meta to Taboola?',
          });
        } finally {
          recording.release();
        }
        await db.pool.query(
          `INSERT INTO watcher_cards(owner_id,anomaly_key,task_id,latest,baseline,summary)
           VALUES($1,'formulaic:ga4:roas',$2,1.2,2.4,'ROAS fell to 1.2 from 2.4.')`,
          [ownerId, anomaly.task.id],
        );
        await db.pool.query(
          'INSERT INTO model_usage(id,owner_id,turn_id,session_id,cost_usd) VALUES($1,$2,$3,$4,3.25)',
          [randomUUID(), ownerId, done.work.turnId, done.task.id],
        );
        const queued = await queue.list();
        assert.equal(queued.length, 2);

        const selected = await digest.collect(new Date(Date.now() - 24 * 60 * 60_000));
        assert.deepEqual(
          selected.decisions.map((item) => item.approvalId),
          queued.map((item) => item.approvalId),
        );
        assert.equal(selected.decisions[0]?.urgent, 'The dispute window closes tonight.');
        assert.equal(selected.decisions[1]?.question, 'Can I run GMAIL_SEND_EMAIL?');
        assert.deepEqual(
          selected.finished.map(({ id, conclusion }) => ({ id, conclusion })),
          [{ id: done.task.id, conclusion: 'ROAS held at 2.4.' }],
        );
        const stuck = selected.stuck.find((item) => item.id === blocked.task.id);
        assert.equal(stuck?.state, 'blocked');
        assert.match(stuck?.reason ?? '', /Plan the launch/);
        assert.equal(
          selected.stuck.some((item) => item.id === escalated.task.id),
          false,
        );
        assert.deepEqual(
          selected.escalations.map(({ id, question }) => ({ id, question })),
          [{ id: escalated.task.id, question: 'Should Formulaic move $200 from Meta to Taboola?' }],
        );
        assert.deepEqual(
          selected.anomalies.map(({ id, summary, open }) => ({ id, summary, open })),
          [{ id: anomaly.task.id, summary: 'ROAS fell to 1.2 from 2.4.', open: true }],
        );
        const spend = new Map(selected.spend.map((client) => [client.client, client]));
        assert.equal(spend.get('formulaic')?.capUsd, 500);
        assert.ok((spend.get('formulaic')?.spentUsd ?? 0) >= 3.25);
        assert.deepEqual(
          { spentUsd: spend.get('rkmd')?.spentUsd, capUsd: spend.get('rkmd')?.capUsd },
          { spentUsd: 0, capUsd: 300 },
        );

        const posted = await digest.post();
        assert.ok(posted.posted);
        assert.equal(posted.telegram, true);
        assert.equal(posted.messageIds.length, 4);
        const saved = (
          await db.pool.query<{
            id: string;
            reply_to_message_id: string | null;
            turn_id: string | null;
          }>(
            'SELECT id,reply_to_message_id,turn_id FROM messages WHERE id=ANY($1::uuid[]) ORDER BY created_at',
            [posted.messageIds],
          )
        ).rows;
        assert.deepEqual(
          saved.map((row) => row.id),
          posted.messageIds,
        );
        assert.deepEqual(
          saved.map((row) => row.reply_to_message_id),
          [null, queued[0]!.messageId, queued[1]!.messageId, null],
        );
        assert.deepEqual((await digest.post()).posted, false);

        await channels.drain();
        const sent = posts.slice(-4);
        assert.equal(sent.length, 4);
        assert.match(sent[0]!.text, /2 decisions need you/);
        assert.match(sent[2]!.text, /Can I run GMAIL_SEND_EMAIL\?/);
        const provider = `provider-${posts.indexOf(sent[2]!) + 1}`;

        await say('approve', 'yes', provider);
        assert.deepEqual(answered.at(-1), { approvalId: queued[1]!.approvalId, approved: true });
        const status = (
          await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id=$1', [
            queued[1]!.approvalId,
          ])
        ).rows[0]?.status;
        assert.equal(status, 'confirmed');
        assert.deepEqual(
          (await queue.list()).map((item) => item.approvalId),
          [queued[0]!.approvalId],
        );
        const declined = await approvals.chat.answer({
          text: 'no',
          channel: 'web',
          threadId,
          replyToMessageId: posted.messageIds[1],
        });
        assert.deepEqual(declined, { approvalId: queued[0]!.approvalId, approved: false });
        await transaction(
          (client) =>
            approvals.chat.accept(client, {
              text: 'no',
              channel: 'web',
              threadId,
              replyToMessageId: posted.messageIds[1],
              answer: declined!,
            }),
          db.pool,
        );
        assert.equal(
          (
            await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id=$1', [
              queued[0]!.approvalId,
            ])
          ).rows[0]?.status,
          'declined',
        );
        assert.deepEqual(await queue.list(), []);
        assert.deepEqual(ran, []);
      },
    );
  },
);
