import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { ConnectedMcpServer } from '../src/ports/agent.ts';
import { loadAgentRegistry } from '../src/server/agents/registry.ts';
import { checkThreshold, writeRefusal, type Threshold } from '../src/server/agents/thresholds.ts';

async function configRoot(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'nod-watchers-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const source = { service: 'krowdit', tool: 'growth_meta_get_insights', values: 'data[].roas' };
const rule = (check: Partial<Threshold>): Threshold => ({
  agent: 'paid-media-analyst',
  source,
  ...check,
});

test('a ROAS drop trips against its baseline and a normal week does not', () => {
  const steady = [3.1, 2.9, 3.0, 3.2, 2.8, 3.0, 3.0, 2.9];
  assert.equal(checkThreshold(rule({ drop: 0.3 }), steady), undefined);
  const dropped = checkThreshold(rule({ drop: 0.3 }), [3.1, 2.9, 3.0, 3.2, 2.8, 3.0, 3.0, 1.8]);
  assert.equal(dropped?.latest, 1.8);
  assert.equal(dropped?.baseline, 3);
  assert.match(dropped?.summary ?? '', /1\.8.*40%.*3/);
});

test('the baseline uses only the configured number of earlier points', () => {
  const series = [10, 10, 10, 2, 2, 2, 1.5];
  assert.equal(checkThreshold(rule({ drop: 0.5, baseline: 3 }), series), undefined);
  assert.ok(checkThreshold(rule({ drop: 0.5 }), series));
});

test('a CPA or refund spike trips on a rise, including a rise from zero', () => {
  assert.equal(checkThreshold(rule({ rise: 0.5 }), [20, 22, 21, 24]), undefined);
  assert.equal(checkThreshold(rule({ rise: 0.5 }), [20, 22, 21, 33])?.latest, 33);
  assert.ok(checkThreshold(rule({ rise: 1 }), [0, 0, 0, 4]));
  assert.equal(checkThreshold(rule({ rise: 1 }), [0, 0, 0, 0]), undefined);
});

test('absolute limits trip on the latest value only', () => {
  assert.ok(checkThreshold(rule({ above: 3 }), [0, 0, 5]));
  assert.equal(checkThreshold(rule({ above: 3 }), [9, 9, 3]), undefined);
  assert.ok(checkThreshold(rule({ below: 10 }), [40, 9]));
  assert.equal(checkThreshold(rule({ below: 10 }), [4, 10]), undefined);
});

test('spend pace compares month-to-date spend with the budget pro-rated by day', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const tenDays = Array.from({ length: 10 }, () => 100);
  assert.equal(
    checkThreshold(rule({ pace: { monthlyUsd: 3000, over: 0.2 } }), tenDays, { now }),
    undefined,
  );
  const trip = checkThreshold(rule({ pace: { monthlyUsd: 2000, over: 0.2 } }), tenDays, { now });
  assert.equal(trip?.latest, 1000);
  assert.ok(Math.abs((trip?.baseline ?? 0) - 666.67) < 0.01);
});

test('spend pace counts the days of the month in the owner time zone', () => {
  const now = new Date('2026-12-01T03:00:00Z');
  const tenDays = Array.from({ length: 10 }, () => 100);
  const threshold = rule({ pace: { monthlyUsd: 3000, over: 0 } });
  assert.equal(
    checkThreshold(threshold, tenDays, { now, timeZone: 'America/New_York' }),
    undefined,
  );
  assert.ok(checkThreshold(threshold, tenDays, { now, timeZone: 'UTC' }));
});

test('only tools that read pass the watcher guard, whatever the server hints', () => {
  const tool = (name: string, annotations?: Record<string, unknown>) => ({
    name,
    inputSchema: {},
    ...(annotations ? { annotations } : {}),
  });
  for (const name of [
    'growth_meta_get_insights',
    'growth_ga4_run_report',
    'growth_stripe_list_charges',
  ])
    assert.equal(writeRefusal(tool(name), name), undefined, name);
  for (const name of [
    'refund_stripe_create_refund',
    'mail_gmail_send',
    'report_spam',
    'list_and_delete',
    'run_script',
    'sync',
  ])
    assert.match(writeRefusal(tool(name), name) ?? '', /read-only/, name);
  assert.match(
    writeRefusal(tool('growth_meta_get_flags', { readOnlyHint: false }), 'growth_meta_get_flags') ??
      '',
    /read-only/,
  );
  assert.match(writeRefusal(tool('sync', { readOnlyHint: true }), 'sync') ?? '', /read-only/);
  assert.match(writeRefusal(undefined, 'growth_meta_get_insights') ?? '', /not a tool/);
});

test('a drop or rise with fewer than two points never trips, and an empty series is an error', () => {
  assert.equal(checkThreshold(rule({ drop: 0.1 }), [1]), undefined);
  assert.throws(() => checkThreshold(rule({ above: 1 }), []), /no numbers/);
});

const growth = {
  'core/team.md': `---
lead: router
routing: Routes the owner's requests.
---
`,
  'core/router.md': `---
title: Router
role: Routes requests.
tools: [task]
---
Route.
`,
  'growth/team.md': `---
lead: paid-media-analyst
routing: Owns client growth metrics.
---
`,
  'growth/paid-media-analyst.md': `---
title: Paid Media Analyst
role: Finds why paid media metrics moved.
tools: [apps, task]
---
Investigate with evidence.
`,
};

const clientFile = (thresholds: string) => `---
title: RKMD
budget:
  monthlyUsd: 500
connections:
  - service: krowdit
    account: rkmd
${thresholds}---
RKMD sells clinic services.
`;

test('client thresholds load with exactly one check each and a broken one is refused with the reason', async () => {
  const root = await configRoot({
    ...growth,
    'clients/rkmd.md': clientFile(`thresholds:
  roas-drop:
    agent: paid-media-analyst
    source: { service: krowdit, tool: growth_meta_get_insights, values: "data[].roas" }
    drop: 0.3
`),
    'clients/formulaic.md': clientFile(`thresholds:
  cpa-spike:
    agent: paid-media-analyst
    source: { service: krowdit, tool: growth_meta_get_insights, values: "data[].cpa" }
    rise: 0.5
    above: 40
`).replace('RKMD', 'Formulaic'),
    'clients/krowdit.md': clientFile(`thresholds:
  spend:
    agent: paid-media-analyst
    source: { service: krowdit, tool: growth_meta_get_insights, values: "data[].spend" }
    drop: 0.3
    typo: 1
`).replace('RKMD', 'Krowdit'),
  });
  try {
    const registry = await loadAgentRegistry(root);
    assert.equal(registry.clients.get('rkmd')?.thresholds?.['roas-drop']?.drop, 0.3);
    assert.ok(!registry.clients.has('formulaic'));
    assert.ok(!registry.clients.has('krowdit'));
    const reasons = new Map(registry.problems.map((problem) => [problem.path, problem.reason]));
    assert.match(reasons.get('clients/formulaic.md') ?? '', /cpa-spike.*exactly one.*rise, above/);
    assert.match(reasons.get('clients/krowdit.md') ?? '', /typo/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const insights = (values: number[]) => ({
  content: [{ type: 'text', text: JSON.stringify({ data: values.map((roas) => ({ roas })) }) }],
});

test(
  'watchers open one investigation card per anomaly, call no model when nothing trips and refuse write tools',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 },
  async (t) => {
    const pg = (await import('pg')).default;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_watchers_${suffix}`;
    const bossSchema = `test_watchers_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const root = await configRoot({
      ...growth,
      'clients/rkmd.md': clientFile(`thresholds:
  roas-drop:
    agent: paid-media-analyst
    source: { service: krowdit, tool: growth_meta_get_insights, input: { level: account }, values: "data[].roas" }
    drop: 0.3
  failed-payments:
    agent: paid-media-analyst
    source: { service: krowdit, tool: growth_stripe_list_charges, values: "data[status=failed].amount", combine: count }
    above: 2
  sneaky:
    agent: paid-media-analyst
    source: { service: krowdit, tool: refund_stripe_create_refund, values: "data[].amount" }
    above: 0
  flagged:
    agent: paid-media-analyst
    source: { service: krowdit, tool: growth_meta_flag, values: "data[].roas" }
    above: 0
`),
      'clients/formulaic.md': clientFile(`thresholds:
  roas-drop:
    agent: paid-media-analyst
    source: { service: krowdit, tool: growth_meta_get_insights, values: "data[].roas" }
    drop: 0.3
`)
        .replace('RKMD', 'Formulaic')
        .replace('account: rkmd', 'account: formulaic'),
    });
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createTasks } = await import('../src/server/tasks.ts');
    const { createCards } = await import('../src/server/agents/cards.ts');
    const { createWatchers } = await import('../src/server/agents/watchers.ts');
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

    const server = (accountName: string): ConnectedMcpServer => ({
      connectionId: randomUUID(),
      pathId: randomUUID(),
      service: 'krowdit',
      name: 'Krowdit',
      accountName,
      tools: [
        { name: 'growth_meta_get_insights', inputSchema: {} },
        { name: 'growth_stripe_list_charges', inputSchema: {} },
        { name: 'refund_stripe_create_refund', inputSchema: {} },
        {
          name: 'growth_meta_flag',
          inputSchema: {},
          annotations: { readOnlyHint: false },
        },
      ],
    });
    const rkmd = server('rkmd');
    const formulaic = server('formulaic');
    let rkmdRoas = [3.1, 2.9, 3.0, 3.2, 3.0];
    let failed = 1;
    const calls: Array<{ connectionId: string; tool: string; input: Record<string, unknown> }> = [];
    const problems: string[] = [];
    const watchers = createWatchers({
      pool: db.pool,
      ownerId,
      registry: async () => registry,
      servers: async () => [rkmd, formulaic],
      call: async (call) => {
        calls.push({ connectionId: call.connectionId, tool: call.tool, input: call.input });
        if (call.tool === 'growth_stripe_list_charges')
          return {
            structuredContent: {
              data: [
                ...Array.from({ length: failed }, () => ({ status: 'failed', amount: 30 })),
                { status: 'succeeded', amount: 50 },
              ],
            },
          };
        return insights(call.connectionId === rkmd.connectionId ? rkmdRoas : [2, 2, 2, 2]);
      },
      problem: (reason) => problems.push(reason),
    });
    const openCards = async () =>
      (
        await db.pool.query<{ client: string; agent: string; card_type: string; title: string }>(
          `SELECT c.client,c.agent,c.card_type,t.title FROM agent_cards c JOIN tasks t ON t.id=c.task_id
           WHERE t.state='open' ORDER BY t.title`,
        )
      ).rows;

    await t.test('nothing trips, so no card, turn or model request happens', async () => {
      const run = await watchers.run();
      assert.equal(run.opened.length, 0);
      assert.equal((await db.pool.query('SELECT 1 FROM tasks')).rowCount, 0);
      assert.equal((await db.pool.query('SELECT 1 FROM turns')).rowCount, 0);
      assert.deepEqual(
        calls.find(
          (call) =>
            call.tool === 'growth_meta_get_insights' && call.connectionId === rkmd.connectionId,
        )?.input,
        {
          level: 'account',
        },
      );
    });

    await t.test('write tools are refused before any call, with the tool named', () => {
      assert.ok(!calls.some((call) => call.tool === 'refund_stripe_create_refund'));
      assert.ok(!calls.some((call) => call.tool === 'growth_meta_flag'));
      assert.ok(problems.some((reason) => /refund_stripe_create_refund.*read-only/.test(reason)));
      assert.ok(problems.some((reason) => /growth_meta_flag.*read-only/.test(reason)));
    });

    await t.test('each client reads only through its own connection', () => {
      const formulaicReads = calls.filter((call) => call.connectionId === formulaic.connectionId);
      assert.deepEqual(
        formulaicReads.map((call) => call.tool),
        ['growth_meta_get_insights'],
      );
    });

    await t.test(
      'an anomaly opens one investigation card with the numbers that tripped it',
      async () => {
        rkmdRoas = [3.1, 2.9, 3.0, 3.2, 3.0, 1.5];
        failed = 4;
        const run = await watchers.run();
        assert.equal(run.opened.length, 2);
        const open = await openCards();
        assert.deepEqual(
          open.map((card) => [card.client, card.agent, card.card_type]),
          [
            ['rkmd', 'paid-media-analyst', 'investigation'],
            ['rkmd', 'paid-media-analyst', 'investigation'],
          ],
        );
        const turns = (
          await db.pool.query<{ prompt: string; source: string; background: boolean }>(
            `SELECT u.prompt,u.source,u.background FROM turns u JOIN agent_cards c ON c.task_id=u.task_id
           ORDER BY u.prompt`,
          )
        ).rows;
        assert.equal(turns.length, 2);
        assert.ok(turns.every((turn) => turn.source === 'event' && turn.background));
        assert.ok(turns.some((turn) => /roas-drop/.test(turn.prompt) && /1\.5/.test(turn.prompt)));
        assert.ok(
          turns.some((turn) => /failed-payments/.test(turn.prompt) && /\b4\b/.test(turn.prompt)),
        );
        const bound = await cards.cardFor(
          (
            await db.pool.query<{ session_id: string }>(
              "SELECT session_id FROM tasks WHERE title LIKE '%roas-drop%'",
            )
          ).rows[0]!.session_id,
        );
        assert.deepEqual(bound, {
          agent: 'paid-media-analyst',
          client: 'rkmd',
          role: 'owner',
          card_type: 'investigation',
        });
      },
    );

    await t.test('the same anomaly does not open a second card while one is open', async () => {
      const run = await watchers.run();
      assert.equal(run.opened.length, 0);
      assert.equal(run.held.length, 2);
      assert.equal((await openCards()).length, 2);
    });

    await t.test(
      'a closed card holds until the metric recovers, then a new trip opens a new card',
      async () => {
        await db.pool.query(
          "UPDATE tasks SET state='done',closed_at=now() WHERE title LIKE '%roas-drop%'",
        );
        assert.equal((await watchers.run()).opened.length, 0);
        rkmdRoas = [3.1, 2.9, 3.0, 3.2, 3.0, 3.1];
        assert.equal((await watchers.run()).opened.length, 0);
        rkmdRoas = [3.1, 2.9, 3.0, 3.2, 3.0, 1.2];
        const run = await watchers.run();
        assert.deepEqual(run.opened, ['rkmd:roas-drop']);
        assert.equal((await openCards()).length, 2);
      },
    );

    await t.test(
      'failures name the threshold without copying source data into the log',
      async () => {
        const before = problems.length;
        const leaky = createWatchers({
          pool: db.pool,
          ownerId,
          registry: async () => registry,
          servers: async () => [rkmd, formulaic],
          call: async () => ({
            content: [{ type: 'text', text: '{"data":[{"roas":"patient jane@example.com"}]}' }],
          }),
          problem: (reason) => problems.push(reason),
        });
        await leaky.run();
        const reasons = problems.slice(before).join('\n');
        assert.match(reasons, /rkmd:roas-drop.*not a number/);
        assert.doesNotMatch(reasons, /jane/);
      },
    );

    await t.test(
      'a stored Taboola connection feeds the watcher, behind the client wall',
      async () => {
        const { createAppGrantVault } = await import('../src/server/vault-app-grants.ts');
        const { createTaboola } = await import('../src/server/agents/taboola.ts');
        const grantVault = await createAppGrantVault(db.pool, {
          ownerId,
          keyStore: { id: 'test', configured: true, getKey: async () => Buffer.alloc(32, 7) },
        });
        let spent = [100, 110, 95, 105, 100, 98, 102, 104];
        const recorded = recordedTaboola(() => spent);
        const taboola = createTaboola({
          pool: db.pool,
          ownerId,
          grantVault,
          fetch: recorded.fetch,
          now: () => new Date('2026-11-15T15:00:00Z'),
        });
        await taboola.initialize();
        const input = { clientId: 'synthetic-client', accountId: taboolaAccount };
        await assert.rejects(
          taboola.connect({ ...input, clientSecret: 'wrong-secret-123' }),
          /status 401: Bad client credentials/,
        );
        assert.deepEqual(await taboola.list(), []);
        await taboola.connect({ ...input, clientSecret: taboolaSecret });
        const listed = await taboola.list();
        assert.deepEqual(
          listed.map((item) => [item.accountId, item.accountName]),
          [[taboolaAccount, 'RKMD Advertiser']],
        );
        const stored = await db.pool.query('SELECT * FROM vault_app_grants');
        assert.ok(stored.rowCount);
        assert.doesNotMatch(JSON.stringify(stored.rows), new RegExp(taboolaSecret));

        const taboolaClient = (title: string, account: string) => `---
title: ${title}
budget:
  monthlyUsd: 500
connections:
  - service: taboola
    account: ${account}
thresholds:
  taboola-spend:
    agent: paid-media-analyst
    source: { service: taboola, tool: get_campaign_summary, input: { days: 8 }, values: "results[].spent" }
    drop: 0.5
---
`;
        const taboolaRoot = await configRoot({
          ...growth,
          'clients/rkmd.md': taboolaClient('RKMD', taboolaAccount),
          'clients/formulaic.md': taboolaClient('Formulaic', 'formulaic-advertiser'),
        });
        t.after(() => rm(taboolaRoot, { recursive: true, force: true }));
        const taboolaRegistry = await loadAgentRegistry(taboolaRoot);
        assert.deepEqual(taboolaRegistry.problems, []);
        const sources = taboola.alongside({
          servers: async () => [],
          call: async () => {
            throw new Error('Only Taboola is connected in this test.');
          },
        });
        const before = problems.length;
        const taboolaWatchers = createWatchers({
          pool: db.pool,
          ownerId,
          registry: async () => taboolaRegistry,
          ...sources,
          problem: (reason) => problems.push(reason),
        });
        assert.deepEqual((await taboolaWatchers.run()).opened, []);
        assert.match(
          problems.slice(before).join('\n'),
          /formulaic:taboola-spend.*Formulaic has no connected taboola/,
        );
        spent = [100, 110, 95, 105, 100, 98, 102, 31];
        assert.deepEqual((await taboolaWatchers.run()).opened, ['rkmd:taboola-spend']);
        const prompt = (
          await db.pool.query<{ prompt: string }>(
            `SELECT u.prompt FROM turns u JOIN tasks t ON t.id=u.task_id
             WHERE t.title LIKE '%taboola-spend%'`,
          )
        ).rows[0]?.prompt;
        assert.match(prompt ?? '', /get_campaign_summary results\[\]\.spent: 31 is down/);
        assert.ok(
          recorded.requests.every(
            (request) =>
              request.method === 'GET' || request.url.pathname === '/backstage/oauth/token',
          ),
        );
        await taboola.disconnect(listed[0]!.id);
        assert.deepEqual(await taboola.list(), []);
        assert.equal((await db.pool.query('SELECT 1 FROM vault_app_grants')).rowCount, 0);
      },
    );
  },
);

const taboolaAccount = 'rkmd-advertiser';
const taboolaSecret = 'synthetic-secret-0f9e8d7c';

function recordedTaboola(spent: () => number[]) {
  const requests: Array<{ method: string; url: URL; authorization?: string; body?: string }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    requests.push({
      method: init.method ?? 'GET',
      url,
      authorization: headers.get('authorization') ?? undefined,
      body: init.body ? String(init.body) : undefined,
    });
    if (url.pathname === '/backstage/oauth/token') {
      const form = new URLSearchParams(String(init.body));
      return form.get('client_secret') === taboolaSecret
        ? json({ access_token: 'synthetic-token-1', token_type: 'bearer', expires_in: 43200 })
        : json({ error: 'invalid_client', error_description: 'Bad client credentials' }, 401);
    }
    if (headers.get('authorization') !== 'Bearer synthetic-token-1')
      return json({ http_status: 401, message: 'Unauthorized' }, 401);
    if (url.pathname === '/backstage/api/1.0/users/current/allowed-accounts')
      return json({
        results: [{ id: 101, name: 'RKMD Advertiser', account_id: taboolaAccount }],
      });
    if (url.pathname === `/backstage/api/1.0/${taboolaAccount}/campaigns`)
      return json({ results: [{ id: '9001', name: 'Clinic leads', status: 'RUNNING' }] });
    if (
      url.pathname ===
      `/backstage/api/1.0/${taboolaAccount}/reports/campaign-summary/dimensions/day`
    ) {
      const values = spent();
      const end = new Date(`${url.searchParams.get('end_date')}T00:00:00Z`);
      const rows = values.map((value, index) => ({
        date: new Date(end.getTime() - (values.length - 1 - index) * 86_400_000)
          .toISOString()
          .slice(0, 10)
          .concat(' 00:00:00.0'),
        spent: value,
        clicks: 100,
      }));
      return json({ results: rows.reverse(), recordCount: rows.length });
    }
    return json({ http_status: 404, message: `No route ${url.pathname}` }, 404);
  };
  return { fetch, requests };
}

test('the Taboola connection offers only reads and sends the API nothing but GETs', async () => {
  const { taboolaSource, taboolaTools } = await import('../src/server/agents/taboola.ts');
  const recorded = recordedTaboola(() => [120, 130, 125]);
  const source = taboolaSource(
    { clientId: 'synthetic-client', clientSecret: taboolaSecret, accountId: taboolaAccount },
    { fetch: recorded.fetch, now: () => new Date('2026-11-15T15:00:00Z') },
  );
  for (const tool of taboolaTools) assert.equal(writeRefusal(tool, tool.name), undefined);

  const report = (await source.call('get_campaign_summary', { days: 3 })) as {
    structuredContent: { results: Array<{ date: string; spent: number }> };
  };
  assert.deepEqual(
    report.structuredContent.results.map((row) => row.spent),
    [120, 130, 125],
  );
  const read = recorded.requests.at(-1)!;
  assert.equal(read.url.searchParams.get('start_date'), '2026-11-12');
  assert.equal(read.url.searchParams.get('end_date'), '2026-11-14');
  await source.call('list_campaigns', {});
  await source.call('get_campaign_summary', { monthToDate: true, includeToday: true });
  assert.equal(recorded.requests.at(-1)!.url.searchParams.get('start_date'), '2026-11-01');
  assert.equal(recorded.requests.at(-1)!.url.searchParams.get('end_date'), '2026-11-15');
  const firstOfMonth = taboolaSource(
    { clientId: 'synthetic-client', clientSecret: taboolaSecret, accountId: taboolaAccount },
    { fetch: recorded.fetch, now: () => new Date('2026-12-01T15:00:00Z') },
  );
  await firstOfMonth.call('get_campaign_summary', { monthToDate: true });
  assert.equal(recorded.requests.at(-1)!.url.searchParams.get('start_date'), '2026-12-01');
  assert.equal(recorded.requests.at(-1)!.url.searchParams.get('end_date'), '2026-12-01');

  const before = recorded.requests.length;
  await assert.rejects(
    source.call('update_campaign', { id: '9001', is_active: false }),
    /update_campaign is not a Taboola tool.*only reads/,
  );
  assert.equal(recorded.requests.length, before);
  assert.deepEqual(
    recorded.requests.map((request) => `${request.method} ${request.url.pathname.split('/')[2]}`),
    ['POST oauth', 'GET api', 'GET api', 'GET api', 'POST oauth', 'GET api'],
  );
});

test('a Taboola failure keeps the status and reason and never shows the secret', async () => {
  const { taboolaSource } = await import('../src/server/agents/taboola.ts');
  const recorded = recordedTaboola(() => []);
  const wrong = taboolaSource(
    { clientId: 'synthetic-client', clientSecret: 'wrong-secret-123', accountId: taboolaAccount },
    { fetch: recorded.fetch },
  );
  const failure = await wrong.call('list_campaigns', {}).catch((error: Error) => error);
  assert.match(String(failure), /Taboola sign-in failed with status 401: Bad client credentials/);
  assert.doesNotMatch(String(failure), /wrong-secret-123/);
  const missing = taboolaSource(
    { clientId: 'synthetic-client', clientSecret: taboolaSecret, accountId: 'other-account' },
    { fetch: recorded.fetch },
  );
  await assert.rejects(missing.call('list_campaigns', {}), /status 404: No route/);
  await assert.rejects(
    missing.verify(),
    /other-account is not an account these credentials can read/,
  );
});
