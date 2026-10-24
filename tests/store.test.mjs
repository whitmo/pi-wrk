import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  storePath, admitJob, listJobs, getJob, updateJob, requestCancel,
  isCancelRequested, touchOwner, closeOwner, ownerAlive, readJobOutput,
  appendJobOutput, writeNotice, readNotices,
} from '../src/store.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-wrk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = storePath(root);
  const input = { request: { runner: 'agent', prompt: 'do work', options: {}, queue: null,
    lifetime: 'session', handoff: false }, ownerId: 'owner-1', projectRoot: root, cwd: root };
  return { root, dir, input };
}

test('admission persists YAML with private permissions and exclusive UUID identity', t => {
  const { root, dir, input } = fixture(t);
  const a = admitJob(dir, input);
  const b = admitJob(dir, input);
  assert.match(a.id, /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  assert.notEqual(a.id, b.id);
  assert.equal(a.status, 'queued');
  assert.equal(a.projectRoot, resolve(root));
  assert.equal(a.cwd, resolve(root));
  assert.deepEqual(getJob(dir, a.id), a);
  assert.deepEqual(listJobs(dir).map(job => job.id).sort(), [a.id, b.id].sort());
  assert.equal(statSync(join(dir, 'jobs')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'jobs', `${a.id}.yaml`)).mode & 0o777, 0o600);
  assert.equal(parse(readFileSync(join(dir, 'jobs', `${a.id}.yaml`), 'utf8')).id, a.id);
  assert.equal(readdirSync(join(dir, 'jobs')).length, 2);
});

test('updates are atomic replacements and may not alter immutable identity fields', t => {
  const { dir, input } = fixture(t);
  const a = admitJob(dir, input);
  const changed = updateJob(dir, a.id, { status: 'running', result: { summary: 'ok' } });
  assert.equal(changed.status, 'running');
  assert.equal(changed.id, a.id);
  assert.equal(changed.ownerId, a.ownerId);
  assert.equal(getJob(dir, a.id).result.summary, 'ok');
  for (const patch of [{ id: 'other' }, { ownerId: 'other' }, { request: {} },
    { projectRoot: '/tmp' }, { cwd: '/tmp' }, { createdAt: 'bad' }, { parentId: 'bad' }]) {
    assert.throws(() => updateJob(dir, a.id, patch), undefined, JSON.stringify(patch));
  }
  assert.equal(getJob(dir, a.id).status, 'running');
});

test('handoff readiness changes without replacing immutable request or identity', t => {
  const { dir, input } = fixture(t);
  const job = admitJob(dir, { ...input, handoff: { ready: false, reason: 'settling' } });
  const changed = updateJob(dir, job.id, { handoff: { ready: true } });
  assert.equal(changed.handoff.ready, true);
  assert.deepEqual(changed.request, job.request);
  assert.equal(changed.status, 'queued');
});

test('child admission preserves and validates immutable parent identity', t => {
  const { dir, input } = fixture(t);
  const parent = admitJob(dir, input);
  const child = admitJob(dir, { ...input, parentId: parent.id });
  assert.equal(getJob(dir, child.id).parentId, parent.id);
  assert.throws(() => admitJob(dir, { ...input, parentId: '../escape' }), /id|uuid/i);
  assert.throws(() => updateJob(dir, child.id, { parentId: child.id }), /immutable/i);
});

test('invalid paths, missing and corrupt job entries cannot be trusted', t => {
  const { dir, input } = fixture(t);
  const a = admitJob(dir, input);
  for (const id of ['../escape', '/tmp/escape', 'not-a-uuid', `${a.id}/x`]) {
    for (const call of [() => getJob(dir, id), () => updateJob(dir, id, { status: 'running' }),
      () => requestCancel(dir, id), () => isCancelRequested(dir, id),
      () => appendJobOutput(dir, id, 'x'), () => readJobOutput(dir, id)]) {
      assert.throws(call, /id|uuid|invalid/i);
    }
  }
  for (const ownerId of ['../bad', 'a/b', '', 'x'.repeat(129)]) {
    for (const call of [() => touchOwner(dir, ownerId), () => closeOwner(dir, ownerId),
      () => ownerAlive(dir, ownerId), () => readNotices(dir, ownerId),
      () => admitJob(dir, { ...input, ownerId }),
      () => writeNotice(dir, { ownerId, jobId: a.id, message: 'x', kind: 'done' })]) {
      assert.throws(call, /owner|invalid/i);
    }
  }
  assert.throws(() => getJob(dir, '11111111-1111-4111-8111-111111111111'), /missing|not found/i);
  writeFileSync(join(dir, 'jobs', `${a.id}.yaml`), 'id: bad\nownerId: owner-1\n');
  assert.throws(() => getJob(dir, a.id), /corrupt|invalid/i);
  assert.deepEqual(listJobs(dir), []);
});

test('cancellation markers are separate and durable, leases expire or close', t => {
  const { dir, input } = fixture(t);
  const a = admitJob(dir, input);
  assert.equal(isCancelRequested(dir, a.id), false);
  requestCancel(dir, a.id);
  requestCancel(dir, a.id);
  assert.equal(isCancelRequested(dir, a.id), true);
  assert.equal(getJob(dir, a.id).status, 'queued');
  touchOwner(dir, 'owner-1');
  assert.equal(ownerAlive(dir, 'owner-1', { leaseMs: 60_000 }), true);
  assert.equal(ownerAlive(dir, 'owner-1', { now: Date.now() + 61_000, leaseMs: 15_000 }), false);
  closeOwner(dir, 'owner-1');
  assert.equal(ownerAlive(dir, 'owner-1'), false);
  assert.equal(ownerAlive(dir, 'missing'), false);
  assert.throws(() => requestCancel(dir, '11111111-1111-4111-8111-111111111111'), /missing|not found/i);
});

test('output retention is bounded and reads a UTF-8-safe byte tail', t => {
  const { dir, input } = fixture(t);
  const a = admitJob(dir, input);
  assert.equal(readJobOutput(dir, a.id), '');
  appendJobOutput(dir, a.id, 'begin\n');
  appendJobOutput(dir, a.id, '😀'.repeat(300_000) + 'END');
  assert.ok(statSync(join(dir, 'output', `${a.id}.log`)).size <= 1_048_576);
  assert.equal(readJobOutput(dir, a.id, { maxBytes: 3 }), 'END');
  assert.equal(readJobOutput(dir, a.id, { maxBytes: 7 }), '😀END');
  assert.ok(!readJobOutput(dir, a.id, { maxBytes: 8 }).includes('�'));
  assert.throws(() => readJobOutput(dir, a.id, { maxBytes: -1 }), /bytes|invalid/i);
});

test('notices persist for a valid owner without triggering consumption', t => {
  const { dir, input } = fixture(t);
  const a = admitJob(dir, input);
  writeNotice(dir, { ownerId: a.ownerId, jobId: a.id, message: 'finished', kind: 'done' });
  assert.equal(readNotices(dir, a.ownerId)[0].message, 'finished');
  assert.deepEqual(readNotices(dir, a.ownerId), readNotices(dir, a.ownerId));
  assert.throws(() => writeNotice(dir, { ownerId: a.ownerId, jobId: '../escape', message: 'x', kind: 'done' }), /id|uuid/i);
});

test('symlinked store entries cannot redirect reads or writes outside the store', t => {
  const { root, dir, input } = fixture(t);
  const a = admitJob(dir, input);
  const elsewhere = join(root, 'elsewhere');
  writeFileSync(elsewhere, 'unchanged');
  const linkedId = '11111111-1111-4111-8111-111111111111';
  symlinkSync(elsewhere, join(dir, 'jobs', `${linkedId}.yaml`));
  assert.throws(() => getJob(dir, linkedId), /symlink|invalid|corrupt/i);
  symlinkSync(elsewhere, join(dir, 'output', `${a.id}.log`));
  assert.throws(() => appendJobOutput(dir, a.id, 'bad'), /symlink|invalid/i);
  assert.equal(readFileSync(elsewhere, 'utf8'), 'unchanged');
});
