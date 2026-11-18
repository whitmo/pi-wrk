import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync, lstatSync, chmodSync, linkSync, readdirSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunners } from './runners.mjs';
import { admitNamedJob, loadNameWords } from './names.mjs';
import { createSwarmWorkspaces } from './workspaces.mjs';
import YAML from 'yaml';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'skipped']);
const lockName = 'worker.lock';
const protocolVersion = 3;
const buildFiles = [...readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.mjs')).map(name => `./${name}`), '../bin/pi-wrk.mjs', '../docs/sorted_short_words.csv'].sort();
const buildId = createHash('sha256').update(buildFiles.map(name => `${name}\0${readFileSync(new URL(name, import.meta.url)).toString('base64')}`).join('\0')).digest('hex');
const incompatibleWorker = () => new Error('Worker protocol mismatch: let active jobs drain, stop the old worker, then restart pi-wrk and retry');
function conditionMatches(job, predecessor) {
  if (job.condition === '&&') return predecessor.status === 'succeeded';
  if (job.condition === '||') return predecessor.status === 'failed';
  if (job.condition === '~&&') return predecessor.status === 'succeeded' && predecessor.verdict === 'success';
  if (job.condition === '~||') return ['succeeded', 'failed'].includes(predecessor.status) && predecessor.verdict === 'failure';
  return false;
}
// Unix socket paths are short (104 bytes on macOS), regardless of checkout depth.
function socketPath(storeDir, token) {
  const uid = process.getuid();
  const dir = join('/tmp', `pi-wrk-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) throw new Error('unsafe worker socket directory');
  chmodSync(dir, 0o700);
  const key = createHash('sha256').update(resolve(storeDir)).digest('hex').slice(0, 32);
  return join(dir, `${key}${token ? `-${token}` : ''}.sock`);
}
const errorText = error => error instanceof Error ? error.message : String(error);

function identity(storeDir) {
  try { return YAML.parse(readFileSync(join(storeDir, lockName), 'utf8')); }
  catch { return null; }
}

function workerDefinitelyDead(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function ask(storeDir, owner, action = 'ping', timeoutMs = 400) {
  return new Promise(resolveReady => {
    if (!owner?.token) return resolveReady(null);
    const socket = createConnection(socketPath(storeDir, owner.protocolVersion === protocolVersion ? owner.token : undefined));
    let data = '', settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); resolveReady(value); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    socket.on('connect', () => { if (action !== 'ping') socket.write(`${JSON.stringify({ token: owner.token, action })}\n`); });
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) finish(data.trim()); });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(data.trim() || null));
  });
}
const ping = async (storeDir, owner, timeoutMs) => await ask(storeDir, owner, 'ping', timeoutMs) === owner?.token;
const nextIdentity = storeDir => {
  try { return YAML.parse(readFileSync(join(storeDir, 'worker.next.lock'), 'utf8')); } catch { return null; }
};

export async function ensureWorker(storeDir, { workerCommand = process.execPath, timeoutMs = 15000, spawnWorker = spawn, retries = 2 } = {}) {
  storeDir = resolve(storeDir);
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const launch = (replacement) => {
    const log = openSync(join(storeDir, 'worker.log'), 'a', 0o600);
    try {
      const child = spawnWorker(workerCommand, [fileURLToPath(new URL('../bin/pi-wrk.mjs', import.meta.url)), 'worker', '--store', storeDir,
        ...(replacement ? ['--replace', replacement] : [])], { detached: true, stdio: ['ignore', log, log], cwd: storeDir });
      child.unref();
      return child;
    } finally { closeSync(log); }
  };
  const attempts = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const old = identity(storeDir);
    const pending = nextIdentity(storeDir);
    if (pending && (!old || workerDefinitelyDead(old))) {
      if (await ping(storeDir, pending)) {
        if (pending.buildId !== buildId) throw new Error('different replacement still draining; cannot start another worker');
        if (!old) return; // Promotion is in progress; do not start a third scheduler.
      }
      if (!workerDefinitelyDead(pending)) throw new Error('replacement owner unresponsive; cannot prove it is dead');
    }
    if (old && await ping(storeDir, old)) {
      if (old.protocolVersion !== protocolVersion) throw incompatibleWorker();
      if (old.buildId === buildId) return;
      const next = nextIdentity(storeDir);
      if (next && await ping(storeDir, next)) {
        if (next.buildId !== buildId || next.replaces !== old.token) throw new Error('another replacement is active; cannot replace it');
        if (await ask(storeDir, old, 'handoff') !== 'handoff-ok') throw new Error('old worker refused safe handoff; it remains serving');
        return;
      }
      if (next && !workerDefinitelyDead(next)) {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until && !workerDefinitelyDead(next)) {
          if (await ping(storeDir, next, 100)) {
            if (next.buildId !== buildId || next.replaces !== old.token) throw new Error('different replacement is active');
            if (await ask(storeDir, old, 'handoff') !== 'handoff-ok') throw new Error('old worker refused safe handoff; it remains serving');
            return;
          }
          await delay(50);
        }
        if (!workerDefinitelyDead(next)) throw new Error('replacement startup timed out; old worker remains serving');
      }
    } else if (old && !workerDefinitelyDead(old)) {
      if (old.protocolVersion !== protocolVersion && await ask(storeDir, { ...old, protocolVersion: 2 }) === old.token) throw incompatibleWorker();
      throw new Error('worker owner unresponsive or incompatible; let active jobs drain, then restart (cannot prove owner dead)');
    }
    else if (!old) {
      try { statSync(join(storeDir, lockName)); throw new Error('worker owner unknown; cannot prove it is dead'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const replacement = old && await ping(storeDir, old) ? old.token : null;
    let child, spawnError;
    try { child = launch(replacement); child.once('error', error => { spawnError = error; }); }
    catch (error) { attempts.push(errorText(error)); continue; }
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (spawnError) { attempts.push(`spawn failed: ${spawnError.message}`); break; }
      const current = replacement ? nextIdentity(storeDir) : identity(storeDir);
      if (current && await ping(storeDir, current, 100)) {
        if (current.protocolVersion !== protocolVersion) throw incompatibleWorker();
        if (replacement) {
          if (current.replaces !== replacement || current.buildId !== buildId) throw new Error('replacement identity mismatch; old worker remains serving');
          if (await ask(storeDir, old, 'handoff') !== 'handoff-ok') throw new Error('old worker refused safe handoff; it remains serving');
        }
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) { attempts.push(`worker exited during startup: ${child.exitCode ?? child.signalCode}`); break; }
      await delay(50);
    }
    if (Date.now() >= until) {
      // The child may still be starting. Never retry while its identity is unverified.
      throw new Error(`worker startup timed out; owner may still be alive; see ${join(storeDir, 'worker.log')}`);
    }
    // No retry while a failed candidate remains alive or owns an unverified lock.
    const candidate = replacement ? nextIdentity(storeDir) : identity(storeDir);
    if (candidate && !workerDefinitelyDead(candidate) && !await ping(storeDir, candidate))
      throw new Error(`worker startup failed, owner unverified; ${attempts.join('; ')}; see worker.log`);
    await delay(100);
  }
  throw new Error(`worker startup failed after ${retries + 1} attempts: ${attempts.join('; ')}; see ${join(storeDir, 'worker.log')}`);
}

async function ownWorker(storeDir, replaces) {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const lock = join(storeDir, replaces ? 'worker.next.lock' : lockName);
  const token = randomUUID();
  const sock = socketPath(storeDir, token);
  const reclaim = join(storeDir, 'worker.reclaim.lock');
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeFileSync(fd, YAML.stringify({ pid: process.pid, token, protocolVersion, buildId, ...(replaces ? { replaces } : {}), startedAt: Date.now() }));
      closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = replaces ? nextIdentity(storeDir) : identity(storeDir);
      if (current && await ping(storeDir, current)) throw new Error('worker already running');
      try {
        if (Date.now() - statSync(lock).mtimeMs < 10000) { await delay(100); continue; }
      } catch (problem) { if (problem.code !== 'ENOENT') throw problem; }
      let gate;
      try { gate = openSync(reclaim, 'wx', 0o600); }
      catch (problem) {
        if (problem.code !== 'EEXIST') throw problem;
        try {
          if (Date.now() - statSync(reclaim).mtimeMs > 10000) throw new Error('worker lock reclamation abandoned; inspect worker.reclaim.lock');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(100);
        continue;
      }
      try {
        const owner = replaces ? nextIdentity(storeDir) : identity(storeDir);
        if (!owner) { statSync(lock); throw new Error('worker owner unknown; cannot prove it is dead'); }
        if (Date.now() - statSync(lock).mtimeMs < 10000) continue;
        if (!workerDefinitelyDead(owner)) throw new Error('worker owner unresponsive; cannot prove it is dead');
        if (owner.token === (replaces ? nextIdentity(storeDir) : identity(storeDir))?.token) unlinkSync(lock);
      } catch (problem) { if (problem.code !== 'ENOENT') throw problem; }
      finally { closeSync(gate); unlinkSync(reclaim); }
    }
  }
  try { unlinkSync(sock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let draining = false;
  const server = createServer(connection => {
    connection.setTimeout(400, () => connection.destroy());
    let requested = false;
    connection.on('data', async data => {
      requested = true;
      try {
        const message = JSON.parse(data.toString());
        if (message.token === token && message.action === 'handoff' && !replaces) {
          const next = nextIdentity(storeDir);
          if (next?.replaces === token && next.protocolVersion === protocolVersion && next.buildId && next.token && await ping(storeDir, next)) {
            const marker = join(storeDir, 'worker.handoff');
            writeFileSync(marker, YAML.stringify({ old: token, next: next.token }), { mode: 0o600 });
            draining = true;
            connection.end('handoff-ok\n');
            return;
          }
        }
      } catch { /* unauthorized or incomplete request */ }
      connection.end('handoff-refused\n');
    });
    // Token-only ping remains available for compatibility probes.
    setTimeout(() => { if (!requested && !connection.destroyed) connection.end(`${token}\n`); }, 10).unref();
  });
  try { await new Promise((ok, fail) => server.once('error', fail).listen(sock, ok)); }
  catch (error) { if ((replaces ? nextIdentity(storeDir) : identity(storeDir))?.token === token) unlinkSync(lock); throw error; }
  let promoted = false;
  const release = async () => {
    await new Promise(ok => server.close(ok));
    try { unlinkSync(sock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if ((replaces ? nextIdentity(storeDir) : identity(storeDir))?.token === token) unlinkSync(lock);
    if (promoted && identity(storeDir)?.token === token) unlinkSync(join(storeDir, lockName));
  };
  const promote = () => {
    if (!replaces || promoted) return;
    try { linkSync(lock, join(storeDir, lockName)); }
    catch (error) { if (error.code !== 'EEXIST' || identity(storeDir)?.token !== token) throw error; }
    promoted = true;
    if (nextIdentity(storeDir)?.token === token) unlinkSync(lock);
  };
  return { release, promote, token, get draining() { return draining; }, resume() { draining = false; } };
}

export async function runWorker({ storeDir, pollMs = 100, leaseMs = 15000, concurrency = 3, runners, store, signal, replaces } = {}) {
  if (!storeDir) throw new Error('storeDir required');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be positive');
  const injectedStore = Boolean(store);
  store ??= await import('./store.mjs');
  const words = loadNameWords(new URL('../docs/sorted_short_words.csv', import.meta.url));
  const defaultRunners = !runners;
  runners ??= createRunners();
  if (replaces && (injectedStore || !await ping(storeDir, identity(storeDir)) || identity(storeDir)?.token !== replaces || identity(storeDir)?.protocolVersion !== protocolVersion))
    throw new Error('replacement requires a live compatible worker');
  if (replaces) store.listWorkerJobs(storeDir); // Corrupt inventory cannot pass readiness.
  const ownership = injectedStore ? null : await ownWorker(storeDir, replaces);
  const active = new Map();
  const waiting = new Map();
  const occupiedSlots = () => active.size - waiting.size;
  const promises = new Set();
  const update = (id, patch) => store.updateJob(storeDir, id, { ...patch, updatedAt: new Date().toISOString() });
  const notice = job => {
    try { store.writeNotice(storeDir, { ownerId: job.ownerId, jobId: job.id,
      message: `${job.name ? `${job.name} ` : ''}${job.id}: ${job.status}${job.summary ? ` — ${job.summary}` : ''}${job.error ? `: ${job.error}` : ''}`, kind: job.status }); }
    catch (error) { console.error(`notice for ${job.id} unavailable: ${errorText(error)}`); }
  };
  const cancel = (job, status = 'cancelled') => notice(update(job.id, { status, finishedAt: new Date().toISOString() }));
  function launch(job) {
    const startStatus = job.request.runner === 'router' ? 'routing' : 'running';
    job = injectedStore ? store.claimQueuedJob(storeDir, job.id, { leaseMs, startStatus })
      : store.claimScheduledJob(storeDir, job.id, { leaseMs, startStatus, concurrency });
    if (!job) return false; // Cancellation or owner expiry won the claim.
    const controller = new AbortController();
    active.set(job.id, controller);
    const allowedWorkspaces = new Set();
    const context = {
      signal: controller.signal,
      storeDir,
      emit: text => store.appendJobOutput(storeDir, job.id, text),
      ...(job.request.runner === 'swarm' ? { createWorkspaces: () => {
        const spaces = createSwarmWorkspaces(job);
        for (const workspace of spaces.children) allowedWorkspaces.add(workspace);
        return spaces;
      } } : {}),
      submitChild: (request, workspace) => {
        if (!['agent', 'council', 'swarm'].includes(request.runner) || job.parentId && request.runner !== 'agent') throw new Error('invalid child runner or depth');
        if (workspace && !allowedWorkspaces.has(workspace) || job.request.runner === 'swarm' && !workspace) throw new Error('unregistered child workspace');
        if (workspace) allowedWorkspaces.delete(workspace);
        const child = admitNamedJob(storeDir, { request: { ...request, queue: null, lifetime: job.request.lifetime }, ownerId: job.ownerId, projectRoot: workspace?.projectRoot ?? job.projectRoot, cwd: workspace?.cwd ?? job.cwd, parentId: job.id, ...(job.focus ? { focus: job.focus } : {}) }, words, undefined, store.admitJob);
        return workspace ? update(child.id, { workspace: { branch: workspace.branch, path: workspace.projectRoot } }) : child;
      },
      getChild: async id => {
        waiting.set(job.id, (waiting.get(job.id) ?? 0) + 1);
        if (!injectedStore) update(job.id, { waitingForChild: true });
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
            while (!controller.signal.aborted && (injectedStore ? occupiedSlots() >= concurrency : !store.reacquireSchedulerSlot(storeDir, job.id, concurrency))) await delay(pollMs);
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
        const status = controller.signal.aborted ? (defaultRunners ? 'uncertain' : 'cancelled') : 'succeeded';
        const patch = { status, finishedAt: new Date().toISOString() };
        if (status === 'succeeded' && result?.summary !== undefined) patch.summary = result.summary;
        if (status === 'uncertain') patch.error = 'termination of descendants not verified; operator resolution required';
        notice(update(job.id, patch));
      } catch (error) {
        const status = controller.signal.aborted ? (defaultRunners ? 'uncertain' : 'cancelled') : error?.uncertain ? 'uncertain' : 'failed';
        notice(update(job.id, { status, error: status === 'uncertain' ? `${errorText(error)}; ${controller.signal.aborted ? 'descendant termination unverified; ' : ''}operator resolution required` : errorText(error), finishedAt: new Date().toISOString() }));
      } finally { active.delete(job.id); }
    })();
    promises.add(work);
    work.then(() => promises.delete(work), error => {
      promises.delete(work);
      console.error(`job ${job.id} persistence failed: ${errorText(error)}`);
    });
    return true;
  }
  try {
    if (replaces) {
      // Never recover or replay the previous generation's live runners.
      while (!signal?.aborted) {
        const old = identity(storeDir);
        const marker = (() => { try { return YAML.parse(readFileSync(join(storeDir, 'worker.handoff'), 'utf8')); } catch { return null; } })();
        if (marker?.old === replaces && marker.next === ownership.token) break;
        if (!old || old.token !== replaces || !await ping(storeDir, old)) throw new Error('old worker disappeared before handoff; replacement cannot recover active jobs');
        await delay(pollMs);
      }
    } else for (const job of store.listWorkerJobs(storeDir)) {
      if (job.request.runner !== 'btw' && ['running', 'routing'].includes(job.status)) {
        notice(update(job.id, { status: 'uncertain', error: 'worker restarted without verified runner identity; operator resolution required' }));
      }
    }
    while (!signal?.aborted) {
      if (ownership?.draining) {
        const next = nextIdentity(storeDir);
        if (next && workerDefinitelyDead(next)) {
          // Only a proven-dead replacement permits resuming old admissions.
          ownership.resume();
          try { unlinkSync(join(storeDir, 'worker.handoff')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          for (const job of store.listWorkerJobs(storeDir))
            if (['running', 'routing'].includes(job.status) && !active.has(job.id) && job.request.runner !== 'btw')
              notice(update(job.id, { status: 'uncertain', error: 'replacement lost its active runner; operator resolution required' }));
        }
      }
      if (replaces && !identity(storeDir)) ownership.promote();
      if (replaces && identity(storeDir)?.token === replaces && !await ping(storeDir, identity(storeDir), 100)) {
        if (workerDefinitelyDead(identity(storeDir))) throw new Error('old worker lost during drain; replacement must stop before scheduling further work');
        // An unresponsive but live incumbent is not evidence its runners ended.
        await delay(pollMs);
        continue;
      }
      const jobs = store.listWorkerJobs(storeDir);
      for (const job of jobs) {
        if (terminal.has(job.status)) continue;
        if (job.request.runner === 'btw') {
          if (job.status === 'queued' || !store.ownerAlive(storeDir, job.ownerId, { leaseMs })) {
            notice(update(job.id, { status: 'failed', error: job.status === 'queued'
              ? 'BTW job was not claimed by its owning Pi session'
              : 'Owning Pi session ended before BTW replied', finishedAt: new Date().toISOString() }));
          }
          continue;
        }
        const parent = job.parentId && store.getJob(storeDir, job.parentId);
        const expired = job.request.lifetime !== 'independent' && !store.ownerAlive(storeDir, job.ownerId, { leaseMs });
        const requested = store.isCancelRequested(storeDir, job.id) || (parent && (terminal.has(parent.status) && parent.status !== 'succeeded' || store.isCancelRequested(storeDir, parent.id)));
        if (job.status === 'queued' && (expired || requested)) cancel(job);
        if (active.has(job.id) && (expired || requested)) active.get(job.id).abort();
      }
      // Decide edges before the uncertain-work safety barrier; an uncertain predecessor cannot satisfy either edge.
      for (const job of store.listWorkerJobs(storeDir).filter(j => j.status === 'queued' && j.predecessorId)) {
        const predecessor = store.getJob(storeDir, job.predecessorId);
        if (!terminal.has(predecessor.status) && predecessor.status !== 'uncertain') continue;
        if (!conditionMatches(job, predecessor)) notice(update(job.id, { status: 'skipped', error: `Condition ${job.condition} not satisfied by predecessor ${predecessor.id} (${predecessor.status}${predecessor.verdict ? `, verdict ${predecessor.verdict}` : ', no semantic verdict'})`, finishedAt: new Date().toISOString() }));
      }
      // Unknown mutations may still be active. Do not launch even unrelated work until resolved.
      if (store.listWorkerJobs(storeDir).some(j => j.status === 'uncertain')) { await delay(pollMs); continue; }
      const queued = store.listWorkerJobs(storeDir).filter(j => j.status === 'queued' && j.request.runner !== 'btw' && (!j.handoff || j.handoff.ready === true));
      const busyQueues = new Set(jobs.filter(j => ['running', 'routing'].includes(j.status)).map(j => j.request.queue).filter(Boolean));
      for (const job of queued.reverse()) {
        if (ownership?.draining ? !job.parentId || !active.has(job.parentId) : replaces && job.parentId && !active.has(job.parentId)) continue;
        if (occupiedSlots() >= concurrency) continue;
        if (job.request.queue && busyQueues.has(job.request.queue)) continue;
        if (job.parentId && !active.has(job.parentId)) { if (!replaces && !ownership?.draining) cancel(job); continue; }
        if (job.predecessorId) {
          const predecessor = store.getJob(storeDir, job.predecessorId);
          if (!terminal.has(predecessor.status)) continue;
          if (!conditionMatches(job, predecessor)) continue;
        }
        if (launch(job) && job.request.queue) busyQueues.add(job.request.queue);
      }
      if (ownership?.draining && active.size === 0 && await ping(storeDir, nextIdentity(storeDir), 100)) break;
      await delay(pollMs);
    }
    for (const controller of active.values()) controller.abort();
    await Promise.allSettled([...promises]);
  } catch (error) {
    for (const controller of active.values()) controller.abort();
    await Promise.allSettled([...promises]);
    throw error;
  } finally { await ownership?.release(); }
}
