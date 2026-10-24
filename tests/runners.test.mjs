import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunners } from '../src/runners.mjs';

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

test('router selects only a valid pattern, not unvalidated prose', async () => {
  const runners = createRunners({ invoke: async () => ({ code: 0, output: JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'shell' }] } }) + '\n' + JSON.stringify({ type: 'agent_settled' }) + '\n' }) });
  await assert.rejects(runners.router(job('router'), ctx()), /invalid route/i);
});

test('council and swarm use separate child assignments and synthesis', async () => {
  const prompts = [];
  const children = [];
  const context = { ...ctx(), submitChild: request => { prompts.push(request.prompt); const child = { id: `child-${prompts.length}` }; children.push(child); return child; }, getChild: async id => ({ status: 'succeeded', summary: `result from ${id}` }) };
  const invoke = async (_command, args) => ({ code: 0, output: JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: args.at(-1).includes('Synthesize') ? 'combined' : '["part one", "part two"]' }] } }) + '\n' + JSON.stringify({ type: 'agent_settled' }) + '\n' });
  const runners = createRunners({ invoke });
  assert.equal((await runners.council(job('council'), context)).summary, 'combined');
  assert.equal(prompts.length, 2);
  prompts.length = 0;
  assert.equal((await runners.swarm(job('swarm'), context)).summary, 'combined');
  assert.deepEqual(prompts, ['part one', 'part two']);
});

test('todo fails explicitly without shared task adapter', async () => {
  await assert.rejects(createRunners().todo(job('todo'), ctx()), /todo provider unavailable/i);
});
