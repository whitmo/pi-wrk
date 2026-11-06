import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { admitJob, getJob, readJobOutput, requestCancel, touchOwner } from '../src/store.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { runWorker, ensureWorker } from '../src/worker.mjs';
import { createRunners } from '../src/runners.mjs';

function fixture(jobs) {
  const items = new Map(jobs.map(j => [j.id, { status: 'queued', ownerId: 'owner', cwd: process.cwd(), projectRoot: process.cwd(), ...j, request: { runner: 'agent', prompt: j.id, lifetime: j.lifetime ?? 'independent', ...j.request } }]));
  const cancels = new Set();
  const notices = [];
  return {
    items, cancels, notices,
    store: {
      listJobs: () => [...items.values()].reverse(),
      listWorkerJobs: () => [...items.values()].reverse(),
      claimQueuedJob: (_, id, { startStatus }) => {
        const job = items.get(id);
        if (job.status !== 'queued' || cancels.has(id)) return null;
        const claimed = { ...job, status: startStatus, startedAt: new Date().toISOString() };
        items.set(id, claimed);
        return claimed;
      },
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
  const work = runWorker({ storeDir: '/unused', store: f?.store, runners, concurrency: 2, pollMs: 5, signal: stop.signal, ...options });
  return { stop: async () => { stop.abort(); await work; } };
}

async function until(predicate, timeoutMs = 500) {
  for (let n = 0; n < timeoutMs / 5; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('worker did not reach expected state');
}

test('nested router/council children inherit exact focus snapshot across workspace changes', async () => {
  const { captureFocus } = await import('../src/focus.mjs');
  const { entry } = await import('./fixtures/focus.mjs');
  const focus = captureFocus([entry()], '/source', '/source/src');
  const f = fixture([{ id: 'router', focus, request: { runner: 'router' } }]);
  const seen = [];
  const worker = await running(f, {
    router: async (job, context) => {
      const child = context.submitChild({ runner: 'council', prompt: 'assess', options: {} });
      return { summary: (await context.getChild(child.id)).summary };
    },
    council: async (job, context) => {
      seen.push(job.focus);
      const child = context.submitChild({ runner: 'agent', prompt: 'read', options: {} });
      return { summary: (await context.getChild(child.id)).summary };
    },
    agent: async job => { seen.push(job.focus); return { summary: 'done' }; },
  });
  try {
    await until(() => f.items.get('router').status === 'succeeded');
    assert.equal(seen.length, 2);
    for (const snapshot of seen) assert.deepEqual(snapshot, focus);
  } finally { await worker.stop(); }
});

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

test('cancellation arriving at launch prevents runner invocation', async () => {
  const f = fixture([{ id: 'race' }]);
  const claim = f.store.claimQueuedJob;
  f.store.claimQueuedJob = (...args) => { f.cancels.add('race'); return claim(...args); };
  let launches = 0;
  const worker = await running(f, { agent: async () => { launches++; return {}; } });
  try {
    await until(() => f.items.get('race').status === 'cancelled');
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

test('post-tool failure and ambiguous Pi stream block conditional and unrelated successors', async () => {
  const started = JSON.stringify({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash' });
  for (const output of [
    [started, JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider failed' } }), JSON.stringify({ type: 'agent_settled' })].join('\n'),
    started + '\n{malformed\n',
  ]) {
    const f = fixture([{ id: 'first', request: { options: { model: 'alpha/one', scopedModels: ['beta/two'] } } }]);
    let calls = 0;
    const worker = await running(f, createRunners({ availableModels: ['alpha/one', 'beta/two'], invoke: async () => { calls++; return { code: 0, output }; } }), { concurrency: 1 });
    try {
      await until(() => f.items.get('first').status === 'uncertain');
      f.items.set('dependent', { id: 'dependent', status: 'queued', ownerId: 'owner', condition: '||', predecessorId: 'first', request: { runner: 'agent', prompt: 'dependent', lifetime: 'independent' } });
      f.items.set('unrelated', { id: 'unrelated', status: 'queued', ownerId: 'owner', request: { runner: 'agent', prompt: 'unrelated', lifetime: 'independent' } });
      await until(() => f.items.get('dependent').status === 'skipped');
      assert.equal(f.items.get('unrelated').status, 'queued');
      assert.equal(calls, 1);
    } finally { await worker.stop(); }
  }
});

test('clear pre-tool provider error remains failed and permits failure successor', async () => {
  const output = [JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider failed' } }), JSON.stringify({ type: 'agent_settled' })].join('\n');
  const f = fixture([{ id: 'first', request: { options: { model: 'alpha/one' } } }]);
  let calls = 0;
  const worker = await running(f, createRunners({ availableModels: ['alpha/one'], invoke: async () => { calls++; return { code: 0, output }; } }), { concurrency: 1 });
  try {
    await until(() => f.items.get('first').status === 'failed');
    f.items.set('dependent', { id: 'dependent', status: 'queued', ownerId: 'owner', condition: '||', predecessorId: 'first', request: { runner: 'agent', prompt: 'dependent', options: { model: 'alpha/one' }, lifetime: 'independent' } });
    await until(() => f.items.get('dependent').status === 'failed');
    assert.equal(calls, 2);
  } finally { await worker.stop(); }
});

test('restart holds unknown active mutation and prevents newly queued work', async () => {
  const f = fixture([{ id: 'unknown', status: 'running' }]);
  let calls = 0;
  const worker = await running(f, { agent: async () => { calls++; return {}; } });
  try {
    await until(() => f.items.get('unknown').status === 'uncertain');
    f.items.set('new', { id: 'new', status: 'queued', ownerId: 'owner', request: { runner: 'agent', prompt: 'new', lifetime: 'independent' } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.items.get('new').status, 'queued');
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
  assert.match(invalid.stderr, /invalid job reference/);
});

test('CLI lists labels with UUIDs, keeps legacy UUIDs, and resolves active labels', t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-cli-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'wrk');
  const input = { ownerId: 'owner', projectRoot: root, cwd: root, request: { runner: 'agent', prompt: 'work', lifetime: 'independent' } };
  const named = admitJob(dir, { ...input, name: 'act.rock.2' });
  const legacy = admitJob(dir, input);
  const bin = new URL('../bin/pi-wrk.mjs', import.meta.url).pathname;
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--store', dir], { encoding: 'utf8' });
  const listed = cli('jobs');
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, new RegExp(`act\\.rock\\.2 ${named.id}`));
  assert.match(listed.stdout, new RegExp(`^${legacy.id} `, 'm'));
  assert.equal(cli('status', named.name).status, 0);
  assert.equal(cli('output', named.name).status, 0);
  assert.equal(cli('cancel', named.name).status, 0);
  assert.equal(cli('status', legacy.id).status, 0);
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
    await until(() => getJob(dir, second.id).status === 'uncertain');
    assert.match(getJob(dir, second.id).error, /termination unverified/);
    const pending = admitJob(dir, { ownerId, projectRoot: dir, cwd: dir, request: { runner: 'shell', prompt: '', options: { command: 'printf unsafe' }, lifetime: 'independent', queue: null } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(getJob(dir, pending.id).status, 'queued');
    assert.equal(getJob(dir, first.id).summary, 'shell exited 0');
  } finally { controller.abort(); await running; rmSync(temp, { recursive: true, force: true }); }
});

test('escaped descendant retaining pipes makes cancellation uncertain and blocks new work', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wrk-escape-'));
  const dir = join(temp, 'wrk');
  const pidPath = join(temp, 'escaped.pid');
  const script = `const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"inherit"});require("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(c.pid));c.unref();setInterval(()=>{},1000)`;
  const request = { runner: 'shell', prompt: '', options: { command: `${process.execPath} -e ${JSON.stringify(script)}` }, lifetime: 'independent', queue: null };
  const job = admitJob(dir, { ownerId: 'owner', projectRoot: temp, cwd: temp, request });
  const controller = new AbortController();
  const work = runWorker({ storeDir: dir, pollMs: 5, signal: controller.signal, concurrency: 1 });
  let escaped;
  try {
    await until(() => existsSync(pidPath));
    escaped = Number(readFileSync(pidPath, 'utf8'));
    requestCancel(dir, job.id);
    await until(() => getJob(dir, job.id).status === 'uncertain', 2500);
    assert.doesNotThrow(() => process.kill(escaped, 0));
    const next = admitJob(dir, { ownerId: 'owner', projectRoot: temp, cwd: temp,
      request: { ...request, options: { command: 'printf must-not-run' } } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(getJob(dir, next.id).status, 'queued');
  } finally {
    if (!escaped && existsSync(pidPath)) escaped = Number(readFileSync(pidPath, 'utf8'));
    if (escaped) { try { process.kill(escaped, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    controller.abort(); await work; rmSync(temp, { recursive: true, force: true });
  }
});

test('successful runner returning no summary succeeds in real YAML store', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wrk-empty-'));
  const dir = join(temp, 'wrk');
  const job = admitJob(dir, { ownerId: 'owner', projectRoot: temp, cwd: temp,
    request: { runner: 'agent', prompt: 'read-only', options: {}, lifetime: 'independent', queue: null } });
  const controller = new AbortController();
  const work = runWorker({ storeDir: dir, pollMs: 5, signal: controller.signal, runners: { agent: async () => ({}) } });
  try {
    await until(() => ['succeeded', 'failed'].includes(getJob(dir, job.id).status));
    assert.equal(getJob(dir, job.id).status, 'succeeded');
  } finally { controller.abort(); await work; rmSync(temp, { recursive: true, force: true }); }
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

test('swarm child jobs retain their own cwd, projectRoot and branch; arbitrary workspace rejected', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wrk-workspaces-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: temp, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(temp, '.gitignore'), '.agents/\n'); git('add', '.gitignore'); git('commit', '-qm', 'base');
  const dir = join(temp, '.agents', 'wrk');
  const { captureFocus } = await import('../src/focus.mjs');
  const { entry } = await import('./fixtures/focus.mjs');
  const focus = captureFocus([entry()], temp, temp);
  const parent = admitJob(dir, { ownerId: 'owner', projectRoot: temp, cwd: temp, focus,
    request: { runner: 'swarm', prompt: 'work', options: {}, lifetime: 'independent', queue: null } });
  const controller = new AbortController();
  const running = runWorker({ storeDir: dir, pollMs: 5, concurrency: 1, signal: controller.signal, runners: {
    swarm: async (_, { createWorkspaces, submitChild, getChild }) => {
      assert.throws(() => submitChild({ runner: 'agent', prompt: 'unsafe' }, { projectRoot: '/tmp', cwd: '/tmp' }), /unregistered/);
      const spaces = createWorkspaces();
      const children = spaces.children.map((workspace, n) => submitChild({ runner: 'agent', prompt: `part ${n}` }, workspace));
      await Promise.all(children.map(child => getChild(child.id)));
      return { summary: 'ready' };
    },
    agent: async job => {
      assert.notEqual(job.projectRoot, temp);
      assert.match(job.workspace.branch, /^wrk\/child-/);
      assert.equal(job.cwd, job.projectRoot);
      assert.equal(job.workspace.path, job.projectRoot);
      assert.deepEqual(job.focus, focus);
      assert.equal(job.focus.sourceRoot, temp);
      return { summary: 'part complete' };
    },
  } });
  try {
    await until(() => ['succeeded', 'failed'].includes(getJob(dir, parent.id).status));
    assert.equal(getJob(dir, parent.id).status, 'succeeded');
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
    const lock = join(dir, 'worker.lock');
    const healthy = readFileSync(lock, 'utf8');
    for (const incompatible of [healthy.replace(/protocolVersion:.*\n/, ''), healthy.replace(/protocolVersion:.*\n/, 'protocolVersion: 0\n')]) {
      writeFileSync(lock, incompatible);
      await assert.rejects(ensureWorker(dir, options), /restart.*drain|drain.*restart/i);
      assert.equal(children.length, 1, 'incompatible live worker must not be terminated or replaced');
    }
    writeFileSync(lock, healthy);
    await ensureWorker(dir, options);
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

test('notice failure cannot overwrite successful runner outcome', async () => {
  const f = fixture([{ id: 'job' }]);
  f.store.writeNotice = () => { throw new Error('notice unavailable'); };
  const worker = await running(f, { agent: async () => ({ summary: 'completed' }) });
  try {
    await until(() => f.items.get('job').status === 'succeeded');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.items.get('job').summary, 'completed');
  } finally { await worker.stop(); }
});

test('corrupt worker inventory stops recovery before launching anything', async () => {
  const f = fixture([{ id: 'queued' }]);
  f.store.listWorkerJobs = () => { throw new Error('corrupt running job'); };
  let launches = 0;
  await assert.rejects(runWorker({ storeDir: '/ignored', store: f.store, signal: AbortSignal.abort(),
    runners: { agent: async () => { launches++; } } }), /corrupt running job/);
  assert.equal(launches, 0);
});

test('corrupt inventory aborts and awaits an active runner before stopping the worker', async () => {
  const f = fixture([{ id: 'running' }]);
  let aborted = false;
  const stop = new AbortController();
  const work = runWorker({ storeDir: '/unused', store: f.store, pollMs: 5, signal: stop.signal,
    runners: { agent: async (_, { signal }) => {
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    } } });
  try {
    await until(() => f.items.get('running').status === 'running');
    f.store.listWorkerJobs = () => { throw new Error('corrupt running job'); };
    await assert.rejects(work, /corrupt running job/);
    assert.equal(aborted, true);
    assert.equal(f.items.get('running').status, 'cancelled');
  } finally { stop.abort(); await work.catch(() => {}); }
});

test('unresponsive live worker lock cannot be replaced or stolen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wrk-live-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'worker.lock');
  writeFileSync(lock, `pid: ${process.pid}\ntoken: blocked-socket\nprotocolVersion: 2\n`);
  const old = new Date(Date.now() - 20000);
  utimesSync(lock, old, old);
  let launches = 0;
  await assert.rejects(ensureWorker(dir, { timeoutMs: 200, spawnWorker: () => { launches++; throw new Error('spawned duplicate'); } }), /unresponsive|alive|owner/i);
  assert.equal(launches, 0);
  await assert.rejects(runWorker({ storeDir: dir, signal: AbortSignal.abort() }), /already running|unresponsive|alive|owner/i);
  assert.equal(existsSync(lock), true);
});

test('detached worker waits out a recent unverifiable lock and becomes ready', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wrk-restart-'));
  const lock = join(temp, 'worker.lock');
  writeFileSync(lock, 'pid: 999999\ntoken: old-unverified\nstartedAt: 1\n');
  const old = new Date(Date.now() - 9600);
  utimesSync(lock, old, old);
  let child;
  try {
    await ensureWorker(temp, { timeoutMs: 4500, spawnWorker: (command, args, options) => {
      child = spawn(command, args, options);
      return child;
    } });
    assert.ok(child?.pid);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.ref();
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    }
    rmSync(temp, { recursive: true, force: true });
  }
});

test('ensureWorker rejects an incompatible worker appearing during startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrk-old-start-'));
  const sock = join('/tmp', `pi-wrk-${process.getuid()}`, `${createHash('sha256').update(dir).digest('hex').slice(0, 32)}.sock`);
  const script = `const fs = require('node:fs'); const net = require('node:net');
    fs.mkdirSync(require('node:path').dirname(${JSON.stringify(sock)}), { recursive: true, mode: 0o700 });
    try { fs.unlinkSync(${JSON.stringify(sock)}); } catch {}
    const server = net.createServer(connection => connection.end('old-token\\n'));
    server.listen(${JSON.stringify(sock)}, () => fs.writeFileSync(${JSON.stringify(join(dir, 'worker.lock'))}, 'token: old-token\\nstartedAt: 1\\n'));`;
  let child;
  try {
    await assert.rejects(ensureWorker(dir, { timeoutMs: 3000, spawnWorker: () => {
      child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
      return child;
    } }), /restart.*drain|drain.*restart/i);
    assert.equal(child.exitCode, null);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.ref(); const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(sock, { force: true });
  }
});

test('ensureWorker reports a startup error rather than accepting dead worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrk-start-'));
  try { await assert.rejects(ensureWorker(dir, { workerCommand: '/no/such/node', timeoutMs: 200 }), /worker|spawn|ENOENT/i); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});


test('conditional jobs wait, skip mismatches, and survive a worker restart in real YAML', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-condition-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'wrk');
  const request = prompt => ({ runner: 'agent', prompt, options: {}, lifetime: 'independent' });
  const first = admitJob(dir, { ownerId: 'one', projectRoot: root, cwd: root, request: request('first') });
  const second = admitJob(dir, { ownerId: 'one', projectRoot: root, cwd: root, request: request('second'), condition: '~&&', predecessorId: first.id });
  const third = admitJob(dir, { ownerId: 'one', projectRoot: root, cwd: root, request: request('third'), condition: '||', predecessorId: second.id });
  const other = admitJob(dir, { ownerId: 'two', projectRoot: root, cwd: root, request: request('other') });
  let resolveFirst;
  const seen = [];
  const runners = { agent: async job => {
    seen.push(job.request.prompt);
    if (job.id === first.id) await new Promise(resolve => { resolveFirst = resolve; });
    return { summary: 'ordinary text is not a semantic verdict' };
  } };
  const worker = await running(null, runners, { store: undefined, storeDir: dir });
  try {
    await until(() => getJob(dir, first.id).status === 'running' && getJob(dir, other.id).status === 'succeeded');
    assert.equal(getJob(dir, second.id).status, 'queued');
    resolveFirst();
    await until(() => getJob(dir, first.id).status === 'succeeded');
  } finally { resolveFirst?.(); await worker.stop(); }
  const restarted = await running(null, runners, { store: undefined, storeDir: dir });
  try {
    await until(() => getJob(dir, second.id).status === 'skipped' && getJob(dir, third.id).status === 'skipped');
    assert.deepEqual(seen.sort(), ['first', 'other']);
    assert.match(getJob(dir, second.id).error, /predecessor|verdict/i);
    assert.equal(getJob(dir, third.id).status, 'skipped');
  } finally { await restarted.stop(); }
});

test('worker applies status and explicit semantic edges; cancellation never satisfies OR', async () => {
  const f = fixture([
    { id: 'ok', status: 'succeeded', verdict: 'failure' },
    { id: 'bad', status: 'failed' },
    { id: 'bad-with-verdict', status: 'failed', verdict: 'failure' },
    { id: 'cancel', status: 'cancelled' },
    ...[['and', '&&', 'ok'], ['or', '||', 'bad'], ['semantic-fail', '~||', 'ok'],
      ['semantic-miss', '~&&', 'bad'], ['semantic-failed-run', '~||', 'bad-with-verdict'], ['cancel-or', '||', 'cancel']].map(([id, condition, predecessorId]) => ({ id, condition, predecessorId })),
  ]);
  const seen = [];
  const worker = await running(f, { agent: async job => { seen.push(job.id); return {}; } });
  try {
    await until(() => ['and', 'or', 'semantic-fail', 'semantic-miss', 'semantic-failed-run', 'cancel-or'].every(id => ['succeeded', 'skipped'].includes(f.items.get(id).status)));
    assert.deepEqual(seen.sort(), ['and', 'or', 'semantic-fail', 'semantic-failed-run']);
    assert.equal(f.items.get('cancel-or').status, 'skipped');
  } finally { await worker.stop(); }
});

test('real-store worker release retains explicit verdict across owner writes and restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-verdict-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'wrk');
  const request = prompt => ({ runner: 'agent', prompt, lifetime: 'independent', options: {} });
  const parent = admitJob(dir, { ownerId: 'session-a', projectRoot: root, cwd: root, request: request('parent') });
  const child = admitJob(dir, { ownerId: 'session-a', projectRoot: root, cwd: root, request: request('child'), condition: '~&&', predecessorId: parent.id });
  const other = admitJob(dir, { ownerId: 'session-b', projectRoot: root, cwd: root, request: request('other') });
  let release;
  const seen = [];
  const runners = { agent: async job => {
    seen.push(job.id);
    if (job.id === parent.id) await new Promise(resolve => { release = resolve; });
    return { summary: 'ordinary text says failure' };
  } };
  const worker = await running(null, runners, { store: undefined, storeDir: dir });
  try {
    await until(() => getJob(dir, parent.id).status === 'running' && getJob(dir, other.id).status === 'succeeded');
    assert.equal(getJob(dir, child.id).status, 'queued');
    const { recordVerdict, updateJob } = await import('../src/store.mjs');
    recordVerdict(dir, parent.id, 'success');
    updateJob(dir, parent.id, { summary: 'owner acknowledged' });
    assert.equal(getJob(dir, parent.id).verdict, 'success');
    const script = `import { updateJob } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
      for (let i = 0; i < 40; i++) {
        updateJob(process.argv[1], process.argv[2], { summary: 'owner ' + i });
        if (i === 0) process.stdout.write('ready\\n');
        await new Promise(resolve => setTimeout(resolve, 1));
      }`;
    const writer = spawn(process.execPath, ['--input-type=module', '-e', script, dir, parent.id], { stdio: ['ignore', 'pipe', 'inherit'] });
    await once(writer.stdout, 'data');
    release();
    const [code] = await once(writer, 'close');
    assert.equal(code, 0);
    await until(() => getJob(dir, parent.id).status === 'succeeded');
  } finally { release?.(); await worker.stop(); }
  const restarted = await running(null, runners, { store: undefined, storeDir: dir });
  try {
    await until(() => getJob(dir, child.id).status === 'succeeded');
    assert.equal(getJob(dir, parent.id).verdict, 'success');
    assert.equal(seen.filter(id => id === child.id).length, 1);
  } finally { await restarted.stop(); }
});

test('uncertain predecessor visibly skips conditional successor without starting unrelated work', async () => {
  const f = fixture([{ id: 'unknown', status: 'running', verdict: 'failure' },
    { id: 'dependent', condition: '~||', predecessorId: 'unknown' }, { id: 'unrelated' }]);
  let launches = 0;
  const worker = await running(f, { agent: async () => { launches++; return {}; } });
  try {
    await until(() => f.items.get('unknown').status === 'uncertain' && f.items.get('dependent').status === 'skipped');
    assert.match(f.items.get('dependent').error, /uncertain/);
    assert.equal(f.items.get('unrelated').status, 'queued');
    assert.equal(launches, 0);
  } finally { await worker.stop(); }
});

test('detached worker gives each routed child a different name and carries it into agent metadata', async () => {
  const f = fixture([{ id: 'route', name: 'act.rock.0', request: { runner: 'router' } }]);
  const seen = [];
  const worker = await running(f, {
    router: async (_job, context) => {
      const one = context.submitChild({ runner: 'agent', prompt: 'one', options: {} });
      const two = context.submitChild({ runner: 'agent', prompt: 'two', options: {} });
      await Promise.all([context.getChild(one.id), context.getChild(two.id)]);
      return { summary: 'done' };
    },
    agent: async job => { seen.push(job); return { summary: 'done' }; },
  });
  try {
    await until(() => f.items.get('route').status === 'succeeded');
    assert.equal(seen.length, 2);
    assert.match(seen[0].name, /^[a-z]+\.[a-z]+\.[0-9]$/);
    assert.notEqual(seen[0].name, seen[1].name);
    assert.equal(seen[0].request.options.name, undefined);
  } finally { await worker.stop(); }
});
