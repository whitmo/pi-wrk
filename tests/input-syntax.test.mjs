import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput } from '../src/input-syntax.mjs';

test('leading prefixes dispatch one existing command, longest conditional first', () => {
  for (const alias of ['&', '&&', '||', '~&&', '~||']) {
    assert.deepEqual(parseInput(`${alias} review changes`), { alias, args: 'review changes', foreground: '' });
  }
  assert.deepEqual(parseInput('&'), { alias: '&', args: '', foreground: '' });
  assert.equal(parseInput('/& review changes'), null);
  assert.equal(parseInput('ordinary & literal'), null);
});

test('a separated trailing ampersand backgrounds only the first line', () => {
  assert.deepEqual(parseInput('review changes &\nNow summarize the result'),
    { alias: '&', args: 'review changes', foreground: 'Now summarize the result' });
  assert.deepEqual(parseInput('review changes &'), { alias: '&', args: 'review changes', foreground: '' });
  assert.throws(() => parseInput(' &\nrest'), /ambiguous/i);
  for (const input of ['review changes &&', 'review changes&', 'echo a & b', 'review changes & later'])
    assert.equal(parseInput(input), null);
});

test('explicit block captures only the body and typed options, preserving outside text', () => {
  assert.deepEqual(parseInput('Before\n<& type=swarm model="luna 6 xhigh">do work & now</&>\nAfter'), {
    alias: '&', args: 'swarm do work & now', model: 'luna 6 xhigh', foreground: 'Before\n\nAfter',
  });
  assert.deepEqual(parseInput('<& type=bg>fix this</&>'), { alias: '&', args: 'bg fix this', foreground: '' });
  assert.equal(parseInput('This is <tag> not syntax'), null);
});

test('malformed delimiters and attributes fail closed', () => {
  for (const input of [
    '<& type=swarm>body', 'body</&>', '<& type=swarm>body</&></&>',
    '<& type=swarm>one<& type=bg>two</&></&>', '<& type=swarm>one</&><& type=bg>two</&>',
    '<& type=swarm model=luna>body</&>', '<& type=swarm foo=bar>body</&>',
    '<& model="luna">body</&>', '<& type=swarm type=bg>body</&>',
    '<& type=swarm> </&>', '<& type=swarm body</&>',
  ]) assert.throws(() => parseInput(input), /invalid|malformed|empty|one/i, input);
});
