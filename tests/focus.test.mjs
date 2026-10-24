import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFocus, formatFocus } from '../src/focus.mjs';
import { admitJob, getJob, updateJob } from '../src/store.mjs';
import { parseRequest } from '../src/request.mjs';

import { container, entry } from './fixtures/focus.mjs';

test('capture uses the latest binding, never resurrects a cleared or invalid focus', () => {
  assert.equal(captureFocus([], '/project', '/project'), undefined);
  assert.equal(captureFocus([entry(), entry(null)], '/project', '/project'), undefined);
  assert.throws(() => captureFocus([entry(), entry({})], '/project', '/project'), /focus/i);
  assert.equal(captureFocus([entry(), entry({})], '/project', '/project', 'none'), undefined);
});

test('capture detaches metadata and preserves source paths and subfocus', () => {
  const original = entry({ focus: container(), subfocus: container('api', { kind: 'subfocus', parentId: 'shipping', goals: 'API work' }) });
  const captured = captureFocus([original], '/project', '/project/src');
  original.data.active.focus.goals = 'Changed after queueing';
  assert.equal(captured.active.focus.goals, 'Ship small changes');
  const text = formatFocus(captured);
  assert.match(text, /API work/);
  assert.match(text, /\/project\/docs\/plan.md/);
  assert.match(text, /https:\/\/example.invalid\/spec/);
  assert.match(text, /\/project\/\.agents\/focus\/foci\/shipping\/subfocuses\/api\/kb/);
  assert.doesNotMatch(text, /Changed after queueing/);
});

test('focus paths use the nearest source .agents root, even inside a larger Git project', t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-focus-roots-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, 'nested');
  mkdirSync(join(root, '.git'));
  mkdirSync(join(nested, '.agents'), { recursive: true });
  mkdirSync(join(nested, 'src'));
  const focus = captureFocus([entry()], root, join(nested, 'src'));
  assert.equal(focus.sourceRoot, nested);
  assert.match(formatFocus(focus), new RegExp(`${nested}/docs/plan.md`));
});

test('focus modes are explicit prefixes and task text remains opaque', () => {
  const request = parseRequest('--lifetime independent --focus active a:{model: provider/model} exact --focus none text');
  assert.equal(request.focusMode, 'active');
  assert.equal(request.prompt, 'exact --focus none text');
  assert.equal(request.options.model, 'provider/model');
  assert.equal(parseRequest('--focus none --lifetime independent bg work').lifetime, 'independent');
  assert.equal(parseRequest('--focus active').handoff, true);
  assert.throws(() => parseRequest('--focus live work'), /focus/i);
  assert.throws(() => parseRequest('--focus active sh:{command: echo}'), /shell/i);
});

test('active mode requires a current focus and configured absolute extension', () => {
  assert.throws(() => captureFocus([], '/project', '/project', 'active'), /active focus/i);
  assert.throws(() => captureFocus([entry()], '/project', '/project', 'active'), /extension/i);
  assert.throws(() => captureFocus([entry()], '/project', '/project', 'active', 'relative.ts'), /absolute/i);
});

test('malformed, oversized, and path-traversing focus data cannot enter a job', () => {
  for (const active of [{ focus: container('../escape'), subfocus: null },
    { focus: container('shipping', { goals: 'x'.repeat(501) }), subfocus: null },
    { focus: container(), subfocus: container('api', { kind: 'subfocus', parentId: 'other' }) }]) {
    assert.throws(() => captureFocus([entry(active)], '/project', '/project'), /focus/i);
  }
});

test('persisted focus is immutable and inherited by children despite changed workspace', t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-focus-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.agents/wrk');
  const focus = captureFocus([entry()], root, root);
  const request = { runner: 'agent', prompt: 'work', options: {}, queue: null, lifetime: 'independent' };
  const parent = admitJob(dir, { request, ownerId: 'owner', projectRoot: root, cwd: root, focus });
  focus.active.focus.goals = 'mutated';
  assert.equal(getJob(dir, parent.id).focus.active.focus.goals, 'Ship small changes');
  assert.throws(() => updateJob(dir, parent.id, { focus: null }), /immutable/i);
  const child = admitJob(dir, { request, ownerId: 'owner', projectRoot: join(root, 'child'), cwd: join(root, 'child'), parentId: parent.id });
  assert.deepEqual(child.focus, parent.focus);
  assert.equal(child.focus.sourceRoot, root);
});
