import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunners } from '../src/runners.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSwarmWorkspaces } from '../src/workspaces.mjs';

import { captureFocus } from '../src/focus.mjs';
import { entry } from './fixtures/focus.mjs';

const job = (runner, prompt = 'work', options = {}) => ({ id: 'job', cwd: process.cwd(), projectRoot: process.cwd(), request: { runner, prompt, options } });
const ctx = (signal = new AbortController().signal) => ({ signal, emit: () => {} });

test('shell records output and rejects a nonzero exit', async () => {
  const shell = createRunners().shell;
  const result = await shell(job('shell', '', { command: 'printf shell-ok' }), ctx());
  assert.match(result.output, /shell-ok/);
  await assert.rejects(shell(job('shell', '', { command: 'exit 17' }), ctx()), /17/);
});

test('shell cancellation confirms process group exit', async () => {
  const controller = new AbortController();
  const work = createRunners().shell(job('shell', '', { command: 'sleep 30' }), ctx(controller.signal));
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(work, /cancel|abort/i);
});

test('named agent and model fail if not installed', async () => {
  const runners = createRunners({ definitions: {}, availableModels: ['openai/test'] });
  await assert.rejects(runners.agent(job('agent', 'work', { name: 'unknown' }), ctx()), /unknown agent/i);
  await assert.rejects(runners.agent(job('agent', 'work', { model: 'missing/model' }), ctx()), /unknown model/i);
});

test('agent parses JSON completion and rejects failed assistant despite exit zero', async () => {
  const invoke = async (_command, args) => {
    assert.ok(args.includes('--mode') && args.includes('json'));
    assert.ok(args.includes('--no-extensions') && args.includes('--no-session'));
    return { code: 0, output: [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'denied', content: [] } }),
      JSON.stringify({ type: 'agent_settled' }),
    ].join('\n') };
  };
  await assert.rejects(createRunners({ invoke }).agent(job('agent'), ctx()), /denied/);
});

test('agent explicitly loads only trusted message tool and passes scoped execution environment', async () => {
  let call;
  const invoke = async (command, args, config) => {
    call = { command, args, config };
    return { code: 0, output: [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'finished' }] } }),
      JSON.stringify({ type: 'agent_settled' }),
    ].join('\n') };
  };
  const context = { ...ctx(), storeDir: '/tmp/wrk-private' };
  await createRunners({ invoke }).agent(job('agent', 'exact task', { tools: 'read,grep,find,ls' }), context);
  assert.ok(call.args.includes('--no-extensions'));
  assert.match(call.args[call.args.indexOf('--extension') + 1], /extensions\/runner-messages\.ts$/);
  assert.equal(call.config.env.PI_WRK_STORE, context.storeDir);
  assert.equal(call.config.env.PI_WRK_JOB_ID, 'job');
  assert.deepEqual(call.args[call.args.indexOf('--tools') + 1].split(','), ['read', 'grep', 'find', 'ls', 'wrk_message']);
  assert.equal(call.args.at(-1), 'exact task');
});

test('agent gets captured context without enabling focus extension or changing task', async () => {
  let call;
  const invoke = async (_command, args, config) => {
    call = { args, config };
    return { code: 0, output: JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } }) + '\n' + JSON.stringify({ type: 'agent_settled' }) };
  };
  const focus = captureFocus([entry()], '/source', '/source/src');
  await createRunners({ invoke }).agent({ ...job('agent', 'exact task'), cwd: '/worktree', focus }, ctx());
  assert.ok(call.args.includes('--no-extensions'));
  assert.ok(!call.args.some(arg => arg.endsWith('runner-focus.ts')));
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /Ship small changes/);
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /\/source\/\.agents\/focus/);
  assert.equal(call.args.at(-1), 'exact task');
});

test('missing active focus extension fails before invoking Pi', async () => {
  let calls = 0;
  const focus = { ...captureFocus([entry()], '/source', '/source'), mode: 'active', extensionPath: '/missing/index.ts' };
  await assert.rejects(createRunners({ invoke: async () => { calls++; } }).agent({ ...job('agent'), focus }, ctx()), /unavailable/i);
  assert.equal(calls, 0);
});

test('router selects only a valid pattern, not unvalidated prose', async () => {
  const runners = createRunners({ invoke: async () => ({ code: 0, output: JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'shell' }] } }) + '\n' + JSON.stringify({ type: 'agent_settled' }) + '\n' }) });
  await assert.rejects(runners.router(job('router'), ctx()), /invalid route/i);
});

test('council uses separate read-only child assessments and synthesis', async () => {
  const prompts = [];
  const children = [];
  const context = { ...ctx(), submitChild: request => { prompts.push(request.prompt); const child = { id: `child-${prompts.length}` }; children.push(child); return child; }, getChild: async id => ({ status: 'succeeded', summary: `result from ${id}` }) };
  const invoke = async (_command, args) => ({ code: 0, output: JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: args.at(-1).includes('Synthesize') ? 'combined' : '["part one", "part two"]' }] } }) + '\n' + JSON.stringify({ type: 'agent_settled' }) + '\n' });
  const runners = createRunners({ invoke: async (command, args, config) => {
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /Ship small changes/);
    return invoke(command, args, config);
  } });
  const focusedJob = { ...job('council'), focus: captureFocus([entry()], '/source', '/source') };
  assert.equal((await runners.council(focusedJob, context)).summary, 'combined');
  assert.equal(prompts.length, 2);
});

test('swarm preserves exact assignments in isolated Git worktrees and integrates own commits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-swarm-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, '.gitignore'), '.agents/\n'); git(root, 'add', '.gitignore'); git(root, 'commit', '-qm', 'base');
  const prompts = [];
  const context = { ...ctx(), createWorkspaces: () => createSwarmWorkspaces({ projectRoot: root, cwd: root }),
    submitChild(request, workspace) {
      prompts.push(request.prompt);
      assert.ok(workspace.projectRoot.startsWith(join(root, '.agents', 'worktrees')) || workspace.projectRoot.includes('/.agents/worktrees/'));
      writeFileSync(join(workspace.projectRoot, `part${prompts.length}.txt`), request.prompt);
      git(workspace.projectRoot, 'add', '.'); git(workspace.projectRoot, 'commit', '-qm', 'child');
      return { id: `child-${prompts.length}` };
    }, getChild: async id => ({ status: 'succeeded', summary: `finished ${id}` }) };
  const invoke = async (_command, args) => ({ code: 0, output: [
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: args.at(-1).includes('Synthesize') ? 'reviewed' : '["part one", "part two"]' }] } }),
    JSON.stringify({ type: 'agent_settled' }),
  ].join('\n') });
  const result = await createRunners({ invoke }).swarm({ ...job('swarm', 'build these'), projectRoot: root, cwd: root }, context);
  assert.deepEqual(prompts, ['part one', 'part two']);
  assert.match(result.summary, /integration branch/);
  assert.match(result.summary, /commits: 2/);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '.agents/\n');
});

test('todo fails explicitly without shared task adapter', async () => {
  await assert.rejects(createRunners().todo(job('todo'), ctx()), /todo provider unavailable/i);
});
