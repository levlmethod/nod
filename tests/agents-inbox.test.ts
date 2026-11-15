import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { ObservationBatch, ObservationQuery } from '../src/ports/proactivity.ts';
import { loadAgentRegistry } from '../src/server/agents/registry.ts';

async function configRoot(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'nod-inbox-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const inboxAgent = (tools: string[]) => `---
title: Inbox
role: Triages new mail into cards for the right team.
tools: [${tools.join(', ')}]
---
Open a card only for mail that asks for work.
`;

const files = (inboxTools: string[]) => ({
  'core/team.md': `---
lead: router
routing: Runs the system itself.
---
`,
  'core/router.md': `---
title: Router
role: Routes every request.
tools: [task, ask_user]
---
Route work.
`,
  'core/inbox.md': inboxAgent(inboxTools),
  'growth/team.md': `---
lead: growth-analyst
routing: Owns client growth metrics, traffic and conversion questions.
---
`,
  'growth/growth-analyst.md': `---
title: Growth Analyst
role: Explains metric moves.
tools: [task, apps]
---
Find out why metrics move.
`,
  'creative/team.md': `---
lead: copywriter
routing: Writes copy, replies and creative for clients.
---
`,
  'creative/copywriter.md': `---
title: Copywriter
role: Writes copy and reply drafts.
tools: [task]
---
Write copy.
`,
  'clients/krowdit.md': `---
title: Krowdit
budget:
  monthlyUsd: 500
inboxes: [contact@krowdit.example]
---
The agency itself.
`,
  'clients/rkmd.md': `---
title: RKMD
budget:
  monthlyUsd: 500
inboxes:
  - address: help@rkmd.example
    connection: Help Desk
    tool: help_mail_search
    read: help_mail_read
    args:
      query: in:inbox
---
A client.
`,
  'clients/formulaic.md': `---
title: Formulaic
budget:
  monthlyUsd: 500
inboxes:
  - address: support@formulaic.example
    connection: Krowdit Tools
    tool: support_mail_gmail_search
    args:
      query: in:inbox
---
A client.
`,
});

const gmailThread = (
  threadId: string,
  message: { id: string; from: string; subject: string; text?: string; sent?: boolean },
) => ({
  id: threadId,
  version: message.id,
  available: true,
  data: {
    truncated: true,
    messages: [
      {
        id: message.id,
        from: message.from,
        to: 'contact@krowdit.example',
        subject: message.subject,
        receivedAt: '2026-11-15T12:00:00.000Z',
        sent: message.sent ?? false,
        ...(message.text === undefined
          ? { message: 'Hidden because it gives access to an account.' }
          : { text: message.text }),
      },
    ],
  },
});

type Decision = Record<string, unknown>;

test(
  'the Inbox agent turns new mail into at most one card per thread and never gets tools',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 },
  async (t) => {
    const pg = (await import('pg')).default;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_inbox_${suffix}`;
    const bossSchema = `test_inbox_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const root = await configRoot(files([]));
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createTasks } = await import('../src/server/tasks.ts');
    const { createCards } = await import('../src/server/agents/cards.ts');
    const { createInbox } = await import('../src/server/agents/inbox.ts');
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
    let registry = await loadAgentRegistry(root);
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

    const gmailId = randomUUID();
    const toolsId = randomUUID();
    const helpId = randomUUID();
    const accounts = async () => [
      { connectionId: gmailId, slug: 'gmail', name: 'Gmail', email: 'Contact@krowdit.example' },
      { connectionId: toolsId, slug: 'krowdit-tools', name: 'Krowdit Tools' },
      { connectionId: helpId, slug: 'help-desk', name: 'Help Desk' },
    ];
    let helpList: unknown = { messages: [] };
    const helpMessages = new Map<string, unknown>();
    let gmail: ObservationBatch = { records: [] };
    let support: unknown = { content: [] };
    const reads: Array<ObservationQuery & { sourceId: string }> = [];
    const read = async (input: ObservationQuery & { sourceId: string }) => {
      reads.push(input);
      if (input.sourceId === `connections:${gmailId}`) return gmail;
      if (input.sourceId === `connections:${helpId}` && input.query)
        return {
          records: [
            {
              id: 'tools',
              version: '1',
              available: true,
              data: {
                tools: [
                  { name: 'mcp-2:help_mail_search', description: 'Search', schema: {} },
                  { name: 'mcp-2:help_mail_read', description: 'Read', schema: {} },
                ],
              },
            },
          ],
        };
      if (input.sourceId === `connections:${helpId}` && input.tool) {
        const result =
          input.tool === 'mcp-2:help_mail_search'
            ? helpList
            : helpMessages.get(String((input.args as { id?: unknown }).id));
        if (!result) throw new Error(`No scripted result for ${input.tool}`);
        return { records: [{ id: 'read', version: '1', available: true, data: { result } }] };
      }
      if (input.sourceId === `connections:${toolsId}` && input.query)
        return {
          records: [
            {
              id: 'tools',
              version: '1',
              available: true,
              data: {
                tools: [
                  { name: 'mcp-1:support_mail_gmail_send', description: 'Send', schema: {} },
                  { name: 'mcp-1:support_mail_gmail_search', description: 'Search', schema: {} },
                ],
              },
            },
          ],
        };
      if (input.sourceId === `connections:${toolsId}` && input.tool)
        return {
          records: [
            {
              id: 'read',
              version: '1',
              available: true,
              data: { tool: input.tool, args: input.args, result: support },
            },
          ],
        };
      throw new Error(`Unexpected read of ${input.sourceId}`);
    };
    const decisions = new Map<string, Decision>();
    const triaged: Array<{ instructions: string; input: Record<string, unknown> }> = [];
    const triage = async (instructions: string, input: object) => {
      triaged.push({ instructions, input: input as Record<string, unknown> });
      const subject = (input as { mail: { subject: string } }).mail.subject;
      const decision = decisions.get(subject);
      if (!decision) throw new Error(`No scripted decision for ${subject}`);
      return decision;
    };
    const inbox = createInbox({
      pool: db.pool,
      ownerId,
      registry: async () => registry,
      accounts,
      read,
      triage,
    });
    await inbox.initialize();
    const signal = new AbortController().signal;
    const opened = async () =>
      (
        await db.pool.query(
          `SELECT t.title,t.done_when,t.session_id,t.activity_key,c.agent,c.client,c.estimate_minutes,
             u.source,u.prompt,u.proactive
           FROM tasks t JOIN agent_cards c ON c.task_id=t.id JOIN turns u ON u.id=t.turn_id ORDER BY t.created_at`,
        )
      ).rows;

    await t.test('new mail opens one card for the chosen agent and client', async () => {
      gmail = {
        records: [
          gmailThread('thread-a', {
            id: 'msg-1',
            from: 'Dana <dana@rkmd.example>',
            subject: 'Conversions fell off a cliff',
            text: 'Our conversions halved since Tuesday. Can someone look?',
          }),
        ],
      };
      decisions.set('Conversions fell off a cliff', {
        needsWork: true,
        client: 'rkmd',
        agent: 'growth-analyst',
        title: 'Find why RKMD conversions halved',
        doneWhen: 'The cause of the conversion drop is known with evidence.',
        estimateMinutes: 45,
        reason: 'The client asks us to investigate a conversion drop.',
      });
      const result = await inbox.check(signal);
      assert.equal(result.opened.length, 1);
      const [card] = await opened();
      assert.equal(card.agent, 'growth-analyst');
      assert.equal(card.client, 'rkmd');
      assert.equal(card.estimate_minutes, 45);
      assert.equal(card.title, 'Find why RKMD conversions halved');
      assert.equal(card.source, 'event');
      assert.equal(card.proactive, false);
      assert.match(card.prompt, /Our conversions halved since Tuesday/);
      assert.match(card.prompt, /untrusted/i);
      assert.deepEqual(await cards.cardFor(card.session_id), {
        agent: 'growth-analyst',
        client: 'rkmd',
        role: 'owner',
        card_type: 'work',
      });
      const [call] = triaged;
      assert.equal(
        (call.input.agents as Array<{ name: string }>).some(
          (agent) => agent.name === 'inbox' || agent.name === 'router',
        ),
        false,
      );
      assert.match(call.instructions, /Open a card only for mail that asks for work\./);
    });

    await t.test('a later message in the same thread opens no second card', async () => {
      gmail = {
        records: [
          gmailThread('thread-a', {
            id: 'msg-2',
            from: 'Dana <dana@rkmd.example>',
            subject: 'Re: Conversions fell off a cliff',
            text: 'Any update?',
          }),
        ],
      };
      decisions.set('Re: Conversions fell off a cliff', {
        needsWork: true,
        client: 'rkmd',
        agent: 'growth-analyst',
        title: 'Follow up',
        doneWhen: 'Done.',
        estimateMinutes: 5,
        reason: 'Follow-up.',
      });
      const before = triaged.length;
      const result = await inbox.check(signal);
      assert.equal(result.opened.length, 0);
      assert.equal(triaged.length, before);
      assert.equal((await opened()).length, 1);
    });

    await t.test(
      'routine and account-access mail open no card and routine mail is triaged once',
      async () => {
        gmail = {
          records: [
            gmailThread('thread-b', {
              id: 'msg-3',
              from: 'News <news@vendor.example>',
              subject: 'Our November newsletter',
              text: 'Ten tips for better ads.',
            }),
            gmailThread('thread-c', {
              id: 'msg-4',
              from: 'Bank <noreply@bank.example>',
              subject: 'Your sign-in code',
            }),
            gmailThread('thread-d', {
              id: 'msg-5',
              from: 'Krowdit <contact@krowdit.example>',
              subject: 'Our proposal',
              text: 'Sent by us.',
              sent: true,
            }),
          ],
        };
        decisions.set('Our November newsletter', {
          needsWork: false,
          reason: 'A newsletter asks for nothing.',
        });
        const before = triaged.length;
        assert.equal((await inbox.check(signal)).opened.length, 0);
        assert.equal((await inbox.check(signal)).opened.length, 0);
        assert.deepEqual(
          triaged.slice(before).map((call) => (call.input.mail as { subject: string }).subject),
          ['Our November newsletter'],
        );
        assert.equal((await opened()).length, 1);
      },
    );

    await t.test('the support inbox is read through its named read tool only', async () => {
      gmail = { records: [] };
      support = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              messages: [
                {
                  id: 'support-3',
                  threadId: 'support-thread-1',
                  from: 'Sam <sam@shopper.example>',
                  subject: 'Refund for a double charge',
                  snippet: 'Still waiting, and now I see a third charge.',
                  date: '2026-11-15T14:00:00Z',
                },
                {
                  id: 'support-2',
                  threadId: 'support-thread-1',
                  from: 'Formulaic Support <support@formulaic.example>',
                  subject: 'Re: Refund for a double charge',
                  snippet: 'We are looking into it.',
                  date: '2026-11-15T13:30:00Z',
                },
                {
                  id: 'support-1',
                  threadId: 'support-thread-1',
                  from: 'Sam <sam@shopper.example>',
                  subject: 'Refund for a double charge',
                  snippet: 'I was charged twice for my order.',
                  date: '2026-11-15T13:00:00Z',
                },
              ],
            }),
          },
        ],
      };
      decisions.set('Refund for a double charge', {
        needsWork: true,
        client: 'formulaic',
        agent: 'copywriter',
        title: 'Draft a reply about the double charge',
        doneWhen: 'A reply draft and the refund facts are ready for the owner.',
        estimateMinutes: 20,
        reason: 'A customer reports a double charge.',
      });
      reads.length = 0;
      const result = await inbox.check(signal);
      assert.equal(result.opened.length, 1);
      const toolReads = reads.filter((input) => input.sourceId === `connections:${toolsId}`);
      assert.deepEqual(
        toolReads.map((input) => input.tool ?? `query:${input.query}`),
        ['query:support_mail_gmail_search', 'mcp-1:support_mail_gmail_search'],
      );
      assert.deepEqual(toolReads[1].args, { query: 'in:inbox' });
      const card = (await opened()).at(-1);
      assert.equal(card.client, 'formulaic');
      assert.equal(card.agent, 'copywriter');
      assert.match(card.prompt, /a third charge/);
      assert.match(card.prompt, /support@formulaic\.example/);
    });

    await t.test(
      'an inbox whose search lists only IDs reads each new thread once with its read tool',
      async () => {
        gmail = { records: [] };
        support = { content: [] };
        const gmailMessage = (id: string, threadId: string, from: string, subject: string) => ({
          id,
          threadId,
          labelIds: ['INBOX'],
          snippet: `${subject} body`,
          internalDate: '1794697957000',
          payload: {
            headers: [
              { name: 'From', value: from },
              { name: 'Subject', value: subject },
            ],
          },
        });
        helpList = {
          messages: [
            { id: 'help-3', threadId: 'help-thread-1' },
            { id: 'help-2', threadId: 'help-thread-2' },
            { id: 'help-1', threadId: 'help-thread-1' },
          ],
        };
        helpMessages.set(
          'help-3',
          gmailMessage('help-3', 'help-thread-1', 'Ana <ana@patient.example>', 'Booking broken'),
        );
        helpMessages.set(
          'help-2',
          gmailMessage('help-2', 'help-thread-2', 'News <news@vendor.example>', 'Weekly news'),
        );
        decisions.set('Booking broken', {
          needsWork: true,
          client: 'rkmd',
          agent: 'growth-analyst',
          title: 'Find why booking broke',
          doneWhen: 'The cause and a fix are on the card.',
          estimateMinutes: 30,
          reason: 'A patient cannot book.',
        });
        decisions.set('Weekly news', { needsWork: false, reason: 'A newsletter.' });
        reads.length = 0;
        const result = await inbox.check(signal);
        assert.equal(result.opened.length, 1);
        assert.deepEqual(result.failed, []);
        const helpReads = () =>
          reads
            .filter((input) => input.sourceId === `connections:${helpId}` && input.tool)
            .map((input) => `${input.tool} ${JSON.stringify(input.args)}`);
        assert.deepEqual(helpReads(), [
          'mcp-2:help_mail_search {"query":"in:inbox"}',
          'mcp-2:help_mail_read {"id":"help-3"}',
          'mcp-2:help_mail_read {"id":"help-2"}',
        ]);
        const card = (await opened()).at(-1);
        assert.equal(card.client, 'rkmd');
        assert.equal(card.activity_key, 'inbox:help@rkmd.example:help-thread-1');
        assert.match(card.prompt, /ana@patient\.example/);

        reads.length = 0;
        const again = await inbox.check(signal);
        assert.equal(again.opened.length, 0);
        assert.deepEqual(helpReads(), ['mcp-2:help_mail_search {"query":"in:inbox"}']);
      },
    );

    await t.test('a decision naming no card owner opens nothing and says why', async () => {
      gmail = {
        records: [
          gmailThread('thread-e', {
            id: 'msg-6',
            from: 'Lee <lee@prospect.example>',
            subject: 'Pricing question',
            text: 'What do you charge?',
          }),
        ],
      };
      decisions.set('Pricing question', {
        needsWork: true,
        client: 'krowdit',
        agent: 'inbox',
        title: 'Answer pricing',
        doneWhen: 'Answered.',
        estimateMinutes: 10,
        reason: 'A prospect asks about pricing.',
      });
      const before = (await opened()).length;
      const result = await inbox.check(signal);
      assert.equal(result.opened.length, 0);
      assert.match(result.failed[0]?.reason ?? '', /inbox is not an agent that can own a card/);
      assert.equal((await opened()).length, before);
    });

    await t.test('an Inbox agent config that lists any tool triages nothing', async () => {
      await writeFile(join(root, 'core/inbox.md'), inboxAgent(['apps']));
      registry = await loadAgentRegistry(root);
      gmail = {
        records: [
          gmailThread('thread-f', {
            id: 'msg-7',
            from: 'Kim <kim@rkmd.example>',
            subject: 'Please send the report',
            text: 'Can you send last month’s report?',
          }),
        ],
      };
      const before = triaged.length;
      reads.length = 0;
      const result = await inbox.check(signal);
      assert.equal(result.opened.length, 0);
      assert.equal(triaged.length, before);
      assert.equal(reads.length, 0);
      assert.match(result.failed[0]?.reason ?? '', /must list no tools/);
    });
  },
);
