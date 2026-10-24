import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../src/request.mjs';

const expected = (runner, prompt, options = {}, queue = null, lifetime = 'session', handoff = false) =>
  ({ runner, prompt, options, queue, lifetime, handoff });

test('literal prompts retain Unicode, control-like syntax and whitespace', () => {
  assert.deepEqual(parseRequest('  Explain --lifetime independent and a:{name: x} 🚀\n  exactly  '),
    expected('router', '  Explain --lifetime independent and a:{name: x} 🚀\n  exactly  '));
  assert.deepEqual(parseRequest('bg  echo "hi"  '), expected('agent', ' echo "hi"  '));
  assert.deepEqual(parseRequest('swarm  α\n  β'), expected('swarm', ' α\n  β'));
  assert.deepEqual(parseRequest('sh:{command: "printf 😀"}  literal tail'),
    expected('shell', ' literal tail', { command: 'printf 😀' }));
});

test('routing selectors and leading lifetime flag select distinct jobs', () => {
  assert.deepEqual(parseRequest('--lifetime independent a:{name: ari, model: provider/model} investigate'),
    expected('agent', 'investigate', { name: 'ari', model: 'provider/model' }, null, 'independent'));
  assert.deepEqual(parseRequest('q:{name: review} council assess'),
    expected('council', 'assess', {}, 'review'));
  assert.deepEqual(parseRequest('q:{name: review} fix', { alias: 'bg' }),
    expected('agent', 'fix', {}, 'review'));
  assert.deepEqual(parseRequest('todo'), expected('todo', ''));
  assert.deepEqual(parseRequest('council review'), expected('council', 'review'));
  assert.deepEqual(parseRequest('fix', { alias: 'bg' }), expected('agent', 'fix'));
  assert.deepEqual(parseRequest('fix', { alias: 'wrk' }), expected('router', 'fix'));
});

test('explicit agent selection keeps keyword-prefixed prompt opaque for bg', () => {
  assert.deepEqual(parseRequest('a:{name: ari} council assess', { alias: 'bg' }),
    expected('agent', 'council assess', { name: 'ari' }));
});

test('only bare background commands request handoff', () => {
  assert.deepEqual(parseRequest('   '), expected('agent', '', {}, null, 'session', true));
  assert.deepEqual(parseRequest('', { alias: 'bg' }), expected('agent', '', {}, null, 'session', true));
  assert.deepEqual(parseRequest('--lifetime independent'), expected('agent', '', {}, null, 'independent', true));
  assert.throws(() => parseRequest('', { alias: 'wrk' }), /empty|task/i);
  assert.throws(() => parseRequest('bg '), /empty|task/i);
  assert.throws(() => parseRequest('a:{name: ari} '), /empty|task/i);
  assert.throws(() => parseRequest('sh:{command: ""}'), /command|empty/i);
});

test('reject malformed, malicious and unrecognized YAML selectors', () => {
  for (const input of [
    'a:{name: [oops} work', 'a:{name: ari, name: bob} work',
    'a:{__proto__: {evil: yes}, name: ari} work',
    'a:{name: ari, extra: yes} work', 'a:{name: [ari]} work',
    'a:{name: !foo ari} work', 'q:{name: ../other} work',
    'q:{name: /tmp/other} work', 'q:{name: review/other} work',
    'sh:{command: echo, shell: true} work',
    'x:{name: surprise} work',
  ]) assert.throws(() => parseRequest(input), undefined, input);
});

test('reject invalid lifetime and do not parse flags or selectors in prompt', () => {
  assert.throws(() => parseRequest('--lifetime forever work'), /lifetime/i);
  assert.throws(() => parseRequest('--lifetime'), /lifetime/i);
  assert.deepEqual(parseRequest('start --lifetime independent q:{name: review}'),
    expected('router', 'start --lifetime independent q:{name: review}'));
});
