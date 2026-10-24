import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunners } from './runners.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const lockName = 'worker.lock';
const socketName = 'worker.sock';
const errorText = error => error instanceof Error ? error.message : String(error);

function identity(storeDir) {
  try { return JSON.parse(readFileSync(join(storeDir, lockName), 'utf8')); }
  catch { return null; }
}

function ping(storeDir, token, timeoutMs = 400) {
  return new Promise(resolveReady => {
    if (!token) return resolveReady(false);
    const socket = createConnection(join(storeDir, socketName));
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); resolveReady(false); }, timeoutMs);
    timer.unref();
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) { clearTimeout(timer); socket.destroy(); resolveReady(data.trim() === token); } });
    socket.on('error', () => { clearTimeout(timer); resolveReady(false); });
    socket.on('close', () => { clearTimeout(timer); resolveReady(data.trim() === token); });
  });
}

export async function ensureWorker(storeDir, { workerCommand = process.execPath, timeoutMs = 5000 } = {}) {
  storeDir = resolve(storeDir);
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const existing = identity(storeDir);
  if (existing && await ping(storeDir, existing.token)) return;
  const log = openSync(join(storeDir, 'worker.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(workerCommand, [fileURLToPath(new URL('../bin/pi-wrk.mjs', import.meta.url)), 'worker', '--store', storeDir], {
      detached: true, stdio: ['ignore', log, log], cwd: storeDir,
    });
    child.unref();
  } finally { closeSync(log); }
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (spawnError) throw new Error(`worker startup failed: ${spawnError.message}`);
    const current = identity(storeDir);
    if (current && await ping(storeDir, current.token, 100)) return;
    if (child.exitCode !== null) throw new Error(`worker exited during startup: ${child.exitCode}; see worker.log`);
    await delay(50);
  }
  throw new Error(`worker startup timed out; see ${join(storeDir, 'worker.log')}`);
}

async function ownWorker(storeDir) {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const lock = join(storeDir, lockName);
  const sock = join(storeDir, socketName);
  const token = randomUUID();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }));
      closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = identity(storeDir);
      if (current && await ping(storeDir, current.token)) throw new Error('worker already running');
      try {
        if (Date.now() - statSync(lock).mtimeMs < 10000) throw new Error('worker startup in progress');
        if (current?.token === identity(storeDir)?.token) unlinkSync(lock);
      } catch (problem) { if (problem.code !== 'ENOENT') throw problem; }
    }
  }
  try { unlinkSync(sock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = createServer(connection => connection.end(`${token}\n`));
  try { await new Promise((ok, fail) => server.once('error', fail).listen(sock, ok)); }
  catch (error) { if (identity(storeDir)?.token === token) unlinkSync(lock); throw error; }
  return async () => {
    await new Promise(ok => server.close(ok));
    try { unlinkSync(sock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (identity(storeDir)?.token === token) unlinkSync(lock);
  };
}

export async function runWorker({ storeDir, pollMs = 100, leaseMs = 15000, concurrency = 3, runners, store, signal } = {}) {
  if (!storeDir) throw new Error('storeDir required');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be positive');
  const injectedStore = Boolean(store);
  store ??= await import('./store.mjs');
  runners ??= createRunners();
  const release = injectedStore ? null : await ownWorker(storeDir);
  const active = new Map();
  const waiting = new Map();
  const occupiedSlots = () => active.size - waiting.size;
  const promises = new Set();
  const update = (id, patch) => store.updateJob(storeDir, id, { ...patch, updatedAt: new Date().toISOString() });
  const cancel = (job, status = 'cancelled') => {
    update(job.id, { status, finishedAt: new Date().toISOString() });
    store.writeNotice(storeDir, { ownerId: job.ownerId, jobId: job.id, message: `${job.id}: ${status}`, kind: status });
  };
  function launch(job) {
    const controller = new AbortController();
    active.set(job.id, controller);
    const startStatus = job.request.runner === 'router' ? 'routing' : 'running';
    update(job.id, { status: startStatus, startedAt: new Date().toISOString() });
    const context = {
      signal: controller.signal,
      emit: text => store.appendJobOutput(storeDir, job.id, text),
      submitChild: request => {
        if (!['agent', 'council', 'swarm'].includes(request.runner) || job.parentId && request.runner !== 'agent') throw new Error('invalid child runner or depth');
        return store.admitJob(storeDir, { request: { ...request, queue: null, lifetime: job.request.lifetime }, ownerId: job.ownerId, projectRoot: job.projectRoot, cwd: job.cwd, parentId: job.id });
      },
      getChild: async id => {
        waiting.set(job.id, (waiting.get(job.id) ?? 0) + 1);
        try {
          while (!controller.signal.aborted) {
            const child = store.getJob(storeDir, id);
            if (terminal.has(child.status)) return child;
            await delay(pollMs);
          }
          throw new Error('parent cancelled');
        } finally {
          const remaining = waiting.get(job.id) - 1;
          if (remaining > 0) waiting.set(job.id, remaining);
          else {
            // Reacquire the parent's slot before synthesis resumes.
            while (!controller.signal.aborted && occupiedSlots() >= concurrency) await delay(pollMs);
            waiting.delete(job.id);
          }
        }
      },
    };
    const work = (async () => {
      try {
        const runner = runners[job.request.runner];
        if (!runner) throw new Error(`unsupported runner: ${job.request.runner}`);
        const result = await runner(job, context);
        const status = controller.signal.aborted ? 'cancelled' : 'succeeded';
        update(job.id, { status, summary: status === 'succeeded' ? result?.summary : undefined, finishedAt: new Date().toISOString() });
        store.writeNotice(storeDir, { ownerId: job.ownerId, jobId: job.id, message: `${job.id}: ${status}${result?.summary ? ` — ${result.summary}` : ''}`, kind: status });
      } catch (error) {
        const status = controller.signal.aborted ? 'cancelled' : 'failed';
        update(job.id, { status, error: errorText(error), finishedAt: new Date().toISOString() });
        store.writeNotice(storeDir, { ownerId: job.ownerId, jobId: job.id, message: `${job.id}: ${status}: ${errorText(error)}`, kind: status });
      } finally { active.delete(job.id); }
    })();
    promises.add(work);
    work.finally(() => promises.delete(work));
  }
  try {
    for (const job of store.listJobs(storeDir)) {
      if (['running', 'routing'].includes(job.status)) cancel(job, 'interrupted');
    }
    while (!signal?.aborted) {
      const jobs = store.listJobs(storeDir);
      for (const job of jobs) {
        if (terminal.has(job.status)) continue;
        const parent = job.parentId && store.getJob(storeDir, job.parentId);
        const expired = job.request.lifetime !== 'independent' && !store.ownerAlive(storeDir, job.ownerId, { leaseMs });
        const requested = store.isCancelRequested(storeDir, job.id) || (parent && (terminal.has(parent.status) && parent.status !== 'succeeded' || store.isCancelRequested(storeDir, parent.id)));
        if (job.status === 'queued' && (expired || requested)) cancel(job);
        if (active.has(job.id) && (expired || requested)) active.get(job.id).abort();
      }
      const queued = store.listJobs(storeDir).filter(j => j.status === 'queued' && (!j.handoff || j.handoff.ready === true));
      const busyQueues = new Set([...active.keys()].map(id => store.getJob(storeDir, id).request.queue).filter(Boolean));
      for (const job of queued.reverse()) {
        if (occupiedSlots() >= concurrency) continue;
        if (job.request.queue && busyQueues.has(job.request.queue)) continue;
        if (job.parentId && !active.has(job.parentId)) { cancel(job); continue; }
        launch(job);
        if (job.request.queue) busyQueues.add(job.request.queue);
      }
      await delay(pollMs);
    }
    for (const controller of active.values()) controller.abort();
    await Promise.allSettled([...promises]);
  } finally { await release?.(); }
}
