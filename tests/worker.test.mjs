import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { admitJob, getJob, readJobOutput, requestCancel, touchOwner } from '../src/store.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { runWorker, ensureWorker } from '../src/worker.mjs';

function fixture(jobs) {
  const items = new Map(jobs.map(j => [j.id, { status: 'queued', ownerId: 'owner', cwd: process.cwd(), projectRoot: process.cwd(), ...j, request: { runner: 'agent', prompt: j.id, lifetime: j.lifetime ?? 'independent', ...j.request } }]));
  const cancels = new Set();
  const notices = [];
  return {
    items, cancels, notices,
    store: {
      listJobs: () => [...items.values()].reverse(),
      admitJob: (_, props) => { const job = { id: randomUUID(), status: 'queued', ...props }; items.set(job.id, job); return job; },
      getJob: (_, id) => items.get(id),
      updateJob: (_, id, patch) => { const job = { ...items.get(id), ...patch }; items.set(id, job); return job; },
      isCancelRequested: (_, id) => cancels.has(id),
      ownerAlive: () => true,
      appendJobOutput: () => {},
      writeNotice: (_, notice) => notices.push(notice),
    },
  };
}

async function running(f, runners, options = {}) {
  const stop = new AbortController();
  const work = runWorker({ storeDir: '/unused', store: f.store, runners, concurrency: 2, pollMs: 5, signal: stop.signal, ...options });
  return { stop: async () => { stop.abort(); await work; } };
}

async function until(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('worker did not reach expected state');
}

test('queue is FIFO and one at a time while other queue progresses', async () => {
  const f = fixture([{ id: 'a', request: { runner: 'agent', queue: 'serial' } }, { id: 'b', request: { runner: 'agent', queue: 'serial' } }, { id: 'c', request: { runner: 'agent' } }]);
  let release;
  const started = [];
  const worker = await running(f, { agent: async job => { started.push(job.id); if (job.id === 'a') await new Promise(resolve => { release = resolve; }); return { summary: job.id }; } });
  try {
    await until(() => started.includes('a') && started.includes('c'));
    assert.equal(started.includes('b'), false);
    release();
    await until(() => f.items.get('b').status === 'succeeded');
    assert.ok(started.indexOf('a') < started.indexOf('b'));
  } finally { release?.(); await worker.stop(); }
});

test('expired queued session and unready handoff never launch', async () => {
  const f = fixture([{ id: 'expired', lifetime: 'session' }, { id: 'handoff', handoff: { ready: false } }]);
  f.store.ownerAlive = () => false;
  let launches = 0;
  const worker = await running(f, { agent: async () => { launches++; return {}; } });
  try {
    await until(() => f.items.get('expired').status === 'cancelled');
    assert.equal(f.items.get('handoff').status, 'queued');
    assert.equal(launches, 0);
  } finally { await worker.stop(); }
});

test('cancel running job aborts it and records cancelled only after termination', async () => {
  const f = fixture([{ id: 'running' }]);
  let terminated = false;
  const worker = await running(f, { agent: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { setTimeout(() => { terminated = true; reject(new Error('stopped')); }, 20); }, { once: true })) });
  try {
    await until(() => f.items.get('running').status === 'running');
    f.cancels.add('running');
    await until(() => f.items.get('running').status === 'cancelled');
    assert.equal(terminated, true);
  } finally { await worker.stop(); }
});

test('restart marks uncertain active job interrupted, never reruns it', async () => {
  const f = fixture([{ id: 'unknown', status: 'running' }]);
  let calls = 0;
  const worker = await running(f, { agent: async () => { calls++; return {}; } });
  try {
    await until(() => f.items.get('unknown').status === 'interrupted');
    assert.equal(calls, 0);
  } finally { await worker.stop(); }
});

test('parent may wait on child without occupying the last scheduler slot', async () => {
  const f = fixture([{ id: 'parent', request: { runner: 'council', prompt: 'assess' } }]);
  const worker = await running(f, {
    council: async (_, { submitChild, getChild }) => {
      const child = submitChild({ runner: 'agent', prompt: 'assess independently' });
      const result = await getChild(child.id);
      return { summary: result.summary };
    },
    agent: async () => ({ summary: 'reviewed' }),
  }, { concurrency: 1 });
  try {
    await until(() => f.items.get('parent').status === 'succeeded');
    assert.equal(f.items.get('parent').summary, 'reviewed');
    const child = [...f.items.values()].find(j => j.parentId === 'parent');
    assert.equal(child.status, 'succeeded');
    assert.equal(child.ownerId, 'owner');
  } finally { await worker.stop(); }
});

test('waiting parents release a slot without letting children exceed concurrency', async () => {
  const f = fixture([{ id: 'parent', request: { runner: 'council', prompt: 'assess' } }]);
  let live = 0, peak = 0;
  const worker = await running(f, {
    council: async (_, { submitChild, getChild }) => {
      const children = ['first', 'second'].map(prompt => submitChild({ runner: 'agent', prompt }));
      const results = await Promise.all(children.map(child => getChild(child.id)));
      return { summary: results.map(result => result.summary).join(',') };
    },
    agent: async () => {
      peak = Math.max(peak, ++live);
      await new Promise(resolve => setTimeout(resolve, 20));
      live--;
      return { summary: 'reviewed' };
    },
  }, { concurrency: 1 });
  try {
    await until(() => f.items.get('parent').status === 'succeeded');
    assert.equal(peak, 1);
  } finally { await worker.stop(); }
});

test('CLI rejects relative worker store and invalid job ids', () => {
  const bin = new URL('../bin/pi-wrk.mjs', import.meta.url).pathname;
  const relative = spawnSync(process.execPath, [bin, 'worker', '--store', 'relative'], { encoding: 'utf8' });
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /absolute/);
  const invalid = spawnSync(process.execPath, [bin, 'status', '../escape', '--store', '/tmp/wrk-no-store'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid job id/);
});

test('real store shell job records output, exit and cancellation', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wrk-real-'));
  const dir = join(temp, 'wrk');
  const ownerId = 'owner';
  touchOwner(dir, ownerId);
  const first = admitJob(dir, { ownerId, projectRoot: dir, cwd: dir, request: { runner: 'shell', prompt: '', options: { command: 'printf done' }, lifetime: 'independent', queue: null } });
  const second = admitJob(dir, { ownerId, projectRoot: dir, cwd: dir, request: { runner: 'shell', prompt: '', options: { command: 'sleep 30' }, lifetime: 'independent', queue: null } });
  const controller = new AbortController();
  const running = runWorker({ storeDir: dir, pollMs: 5, signal: controller.signal, concurrency: 1 });
  try {
    await until(() => getJob(dir, first.id).status === 'succeeded');
    assert.equal(readJobOutput(dir, first.id), 'done');
    await until(() => getJob(dir, second.id).status === 'running');
    requestCancel(dir, second.id);
    await until(() => getJob(dir, second.id).status === 'cancelled');
    assert.equal(getJob(dir, first.id).summary, 'shell exited 0');
  } finally { controller.abort(); await running; rmSync(temp, { recursive: true, force: true }); }
});

test('real store admits bounded child and releases parent slot', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wrk-child-'));
  const dir = join(temp, 'wrk');
  touchOwner(dir, 'owner');
  const parent = admitJob(dir, { ownerId: 'owner', projectRoot: temp, cwd: temp, request: { runner: 'router', prompt: 'review', options: {}, lifetime: 'session', queue: null } });
  const controller = new AbortController();
  const running = runWorker({ storeDir: dir, pollMs: 5, concurrency: 1, signal: controller.signal, runners: {
    router: async (_, { submitChild, getChild }) => { const child = submitChild({ runner: 'agent', prompt: 'review', options: {} }); return { summary: (await getChild(child.id)).summary }; },
    agent: async () => ({ summary: 'child finished' }),
  } });
  try {
    await until(() => getJob(dir, parent.id).status === 'succeeded');
    assert.equal(getJob(dir, parent.id).summary, 'child finished');
  } finally { controller.abort(); await running; rmSync(temp, { recursive: true, force: true }); }
});

test('detached worker executes durable admission and reconnects without duplicate launch', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wrk-detached-'));
  const dir = join(temp, 'wrk');
  const children = [];
  const options = {
    workerCommand: '/pi-wrk-test-captured-node',
    spawnWorker: (_command, args, config) => {
      const child = spawn(process.execPath, args, config);
      children.push(child);
      return child;
    },
  };
  const job = admitJob(dir, { ownerId: 'test-owner', projectRoot: temp, cwd: temp,
    request: { runner: 'shell', prompt: '', options: { command: 'printf detached-ok' }, lifetime: 'independent', queue: null } });
  try {
    await ensureWorker(dir, options);
    await Promise.all([ensureWorker(dir, options), ensureWorker(dir, options)]);
    assert.equal(children.length, 1);
    await until(() => getJob(dir, job.id).status === 'succeeded');
    assert.equal(readJobOutput(dir, job.id), 'detached-ok');
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.ref();
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
      }
    }
    rmSync(temp, { recursive: true, force: true });
  }
});

test('ensureWorker reports a startup error rather than accepting dead worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrk-start-'));
  try { await assert.rejects(ensureWorker(dir, { workerCommand: '/no/such/node', timeoutMs: 200 }), /worker|spawn|ENOENT/i); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
