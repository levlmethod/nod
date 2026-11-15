import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Agent, AgentSessionOptions, AgentTool, RuntimeContext } from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { bindAgent, loadAgentRegistry } from '../src/server/agents/registry.ts';
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

test('a missing config root loads as an empty registry with one problem', async () => {
  const registry = await loadAgentRegistry(join(tmpdir(), `nod-agents-missing-${randomUUID()}`));
  assert.equal(registry.agents.size, 0);
  assert.equal(registry.problems.length, 1);
});

test('the main chat runs as the Router; task and background sessions do not', async () => {
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
    assert.equal(
      bindAgent(await loadAgentRegistry(join(root, 'nowhere')), { threadId, sessionId: threadId })
        .agent,
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      assert.match(options.systemPrompt, /Router/);
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
