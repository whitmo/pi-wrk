import {
  mkdirSync, lstatSync, readFileSync, writeFileSync, linkSync, unlinkSync,
  renameSync, readdirSync, openSync, closeSync, fsyncSync, fstatSync, chmodSync,
  constants,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { normalizeFocus } from './focus.mjs';

const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IMMUTABLE = new Set(['id', 'name', 'request', 'ownerId', 'projectRoot', 'cwd', 'createdAt', 'parentId', 'lifetime', 'queue', 'focus', 'predecessorId', 'condition']);
const OUTPUT_LIMIT = 1_048_576;
const QUEUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NAME = /^[a-z]+\.[a-z]+\.[0-9]$/;
const ACTIVE = new Set(['queued', 'running', 'routing', 'uncertain']);
const WORKER_STATUSES = new Set([...ACTIVE, 'succeeded', 'failed', 'cancelled', 'interrupted', 'skipped']);

function queueName(name) {
  if (typeof name !== 'string' || !QUEUE.test(name) || name.includes('..')) throw new Error('invalid queue name');
  return name;
}

export function listQueues(storeDir) {
  const dir = folder(storeDir, 'queues');
  return readdirSync(dir).filter(name => name.endsWith('.yaml')).flatMap(name => {
    try {
      const queue = yamlRead(join(dir, `${queueName(name.slice(0, -5))}.yaml`));
      return queue?.name === name.slice(0, -5) ? [queue] : [];
    } catch { return []; }
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function jobId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('invalid job id (UUID required)');
  return id;
}
function ownerId(id) {
  if (typeof id !== 'string' || !OWNER.test(id)) throw new Error('invalid owner id');
  return id;
}
function directory(path, privateDirectory = true) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`invalid store directory: ${path}`);
  if (privateDirectory) chmodSync(path, 0o700);
  return path;
}
function base(storeDir) {
  if (typeof storeDir !== 'string' || !isAbsolute(storeDir)) throw new Error('invalid store path');
  return resolve(storeDir);
}
function folder(storeDir, name) {
  const root = base(storeDir);
  directory(dirname(root), false);
  directory(root);
  return directory(join(root, name));
}
function location(storeDir, subdir, name) {
  return join(folder(storeDir, subdir), name);
}
function statNoFollow(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`invalid symlink or file: ${path}`);
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function readPrivate(path) {
  if (!statNoFollow(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('invalid store file');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function safeData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || seen.has(value) ||
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new Error('invalid YAML data');
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('invalid YAML map key');
    safeData(item, seen);
  }
  seen.delete(value);
}
function yamlRead(path) {
  const bytes = readPrivate(path);
  if (bytes === null) return null;
  try {
    const doc = parseDocument(bytes.toString('utf8'), { uniqueKeys: true, strict: true });
    if (doc.errors.length) throw doc.errors[0];
    const value = doc.toJS({ maxAliasCount: 0 });
    safeData(value);
    return value;
  } catch (error) { throw new Error(`corrupt YAML entry: ${path}: ${error.message}`); }
}
function atomic(path, data, { exclusive = false } = {}) {
  if (!Buffer.isBuffer(data)) safeData(data);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, Buffer.isBuffer(data) ? data : stringify(data));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    if (exclusive) linkSync(tmp, path); // link, unlike rename, never replaces an existing job.
    else { statNoFollow(path); renameSync(tmp, path); }
  } finally {
    try { unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function existingJob(storeDir, id) {
  const path = location(storeDir, 'jobs', `${jobId(id)}.yaml`);
  const job = yamlRead(path);
  if (job === null) throw new Error(`missing job: ${id}`);
  if (!job || typeof job !== 'object' || Array.isArray(job) || job.id !== id ||
      !UUID.test(job.id) || !OWNER.test(job.ownerId ?? '') ||
      !isAbsolute(job.projectRoot ?? '') || !isAbsolute(job.cwd ?? '') ||
      typeof job.status !== 'string' || typeof job.createdAt !== 'string' ||
      typeof job.updatedAt !== 'string' || !job.request || typeof job.request !== 'object' ||
      (job.name != null && !NAME.test(job.name)) ||
      (job.parentId != null && !UUID.test(job.parentId)) ||
      (job.predecessorId != null && !UUID.test(job.predecessorId)) ||
      (job.condition != null && !['&&', '||', '~&&', '~||'].includes(job.condition)) ||
      (job.verdict != null && !['success', 'failure'].includes(job.verdict)))
    throw new Error(`corrupt job: ${id}`);
  const verdict = yamlRead(location(storeDir, 'verdicts', `${id}.yaml`));
  if (verdict !== null) {
    if (verdict.id !== id || !['success', 'failure'].includes(verdict.verdict)) throw new Error(`corrupt verdict: ${id}`);
    job.verdict = verdict.verdict;
  }
  return job;
}
function utf8Tail(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < Math.min(4, bytes.length); i++) {
    try { return decoder.decode(bytes.subarray(i)); } catch { /* skip incomplete leading character */ }
  }
  return '';
}

export function storePath(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot) throw new Error('invalid project root');
  return join(resolve(projectRoot), '.agents', 'wrk');
}

export function admitJob(storeDir, { request, ownerId: owner, projectRoot, cwd, handoff, parentId, focus, predecessorId, condition, name } = {}) {
  ownerId(owner);
  if (name !== undefined && (typeof name !== 'string' || !NAME.test(name))) throw new Error('invalid work-item name');
  const parent = parentId !== undefined ? existingJob(storeDir, jobId(parentId)) : undefined;
  if (condition !== undefined || predecessorId !== undefined) {
    if (parent || !['&&', '||', '~&&', '~||'].includes(condition) || predecessorId === undefined)
      throw new Error('conditional root requires a condition and predecessor');
    const predecessor = existingJob(storeDir, jobId(predecessorId));
    if (predecessor.ownerId !== owner || predecessor.parentId)
      throw new Error('predecessor must be a root job of the same owner');
  }
  focus = normalizeFocus(parent ? parent.focus : focus);
  if (!isAbsolute(projectRoot ?? '') || !isAbsolute(cwd ?? '')) throw new Error('project root and cwd must be absolute');
  safeData(request);
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.runner !== 'string' ||
      typeof request.prompt !== 'string' || !['session', 'independent'].includes(request.lifetime))
    throw new Error('invalid request');
  if (handoff !== undefined) safeData(handoff);
  if (request.queue != null) {
    const name = queueName(request.queue);
    const path = location(storeDir, 'queues', `${name}.yaml`);
    try { atomic(path, { name, createdAt: new Date().toISOString() }, { exclusive: true }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (yamlRead(path)?.name !== name) throw new Error('corrupt queue definition');
    }
  }
  const jobs = folder(storeDir, 'jobs');
  for (const folderName of ['cancels', 'owners', 'output', 'notices', 'verdicts']) folder(storeDir, folderName);
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomUUID();
    const job = { id, request, ownerId: owner, projectRoot: resolve(projectRoot), cwd: resolve(cwd),
      status: 'queued', createdAt: now, updatedAt: now };
    if (name !== undefined) job.name = name;
    if (focus !== undefined) job.focus = focus;
    if (handoff !== undefined) job.handoff = handoff;
    if (parentId !== undefined) job.parentId = parentId;
    if (condition !== undefined) { job.condition = condition; job.predecessorId = predecessorId; }
    const claim = name === undefined ? null : location(storeDir, 'names', `${name}.yaml`);
    if (claim) atomic(claim, { id, name }, { exclusive: true });
    try { atomic(join(jobs, `${id}.yaml`), job, { exclusive: true }); return job; }
    catch (error) {
      if (claim) unlinkSync(claim);
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not allocate unique job id');
}

export function getJob(storeDir, id) { return existingJob(storeDir, id); }

export function activeJobsByName(storeDir) {
  const registry = Object.create(null);
  for (const job of listJobs(storeDir)) if (job.name && ACTIVE.has(job.status)) registry[job.name] = job.id;
  return registry;
}

export function resolveJobId(storeDir, reference) {
  if (UUID.test(reference ?? '')) return jobId(reference);
  if (typeof reference !== 'string' || !NAME.test(reference)) throw new Error('invalid job reference');
  const claim = yamlRead(location(storeDir, 'names', `${reference}.yaml`));
  if (!claim || !UUID.test(claim.id ?? '') || claim.name !== reference) throw new Error(`no active job named ${reference}`);
  const job = existingJob(storeDir, claim.id);
  if (job.name !== reference || !ACTIVE.has(job.status)) throw new Error(`no active job named ${reference}`);
  return job.id;
}

export function listJobs(storeDir) {
  const jobs = folder(storeDir, 'jobs');
  return readdirSync(jobs).filter(name => UUID.test(name.slice(0, -5)) && name.endsWith('.yaml'))
    .flatMap(name => {
      try { return [existingJob(storeDir, name.slice(0, -5))]; }
      catch { return []; } // One corrupt entry must not hide otherwise healthy jobs.
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function listWorkerJobs(storeDir) {
  const jobs = folder(storeDir, 'jobs');
  return readdirSync(jobs).filter(name => name.endsWith('.yaml'))
    .map(name => {
      const id = name.slice(0, -5);
      if (!UUID.test(id)) throw new Error(`invalid worker job file: ${name}`);
      const job = existingJob(storeDir, id);
      if (!WORKER_STATUSES.has(job.status)) throw new Error(`corrupt job status: ${id}`);
      return job;
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

const sleep = new Int32Array(new SharedArrayBuffer(4));
function lockedJob(storeDir, id, action) {
  const lock = location(storeDir, 'jobs', `${id}.lock`);
  let fd;
  for (let tries = 0; tries < 2000; tries++) {
    try { fd = openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - lstatSync(lock).mtimeMs > 10000) unlinkSync(lock); }
      catch (problem) { if (problem.code !== 'ENOENT') throw problem; }
      Atomics.wait(sleep, 0, 0, 5);
    }
  }
  if (fd === undefined) throw new Error(`job ${id} is locked; retry later`);
  try { return action(); }
  finally { closeSync(fd); unlinkSync(lock); }
}

export function claimQueuedJob(storeDir, id, { leaseMs = 15000, startStatus = 'running' } = {}) {
  jobId(id);
  if (!['running', 'routing'].includes(startStatus)) throw new Error('invalid start status');
  return lockedJob(storeDir, id, () => {
    const job = existingJob(storeDir, id);
    if (job.status !== 'queued' || isCancelRequested(storeDir, id) ||
        job.request.lifetime !== 'independent' && !ownerAlive(storeDir, job.ownerId, { leaseMs })) return null;
    const { verdict: _verdict, ...storedJob } = job;
    const next = { ...storedJob, status: startStatus, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    atomic(location(storeDir, 'jobs', `${id}.yaml`), next);
    return next;
  });
}

function recordVerdictUnlocked(storeDir, id, verdict) {
  jobId(id);
  if (!['success', 'failure'].includes(verdict)) throw new Error('invalid verdict');
  const job = existingJob(storeDir, id);
  if (!['queued', 'running', 'routing'].includes(job.status)) throw new Error('cannot record verdict after terminal status');
  const path = location(storeDir, 'verdicts', `${id}.yaml`);
  try { atomic(path, { id, verdict }, { exclusive: true }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; throw new Error('verdict already recorded'); }
  return verdict;
}
export function recordVerdict(storeDir, id, verdict) {
  return lockedJob(storeDir, jobId(id), () => recordVerdictUnlocked(storeDir, id, verdict));
}

export function updateJob(storeDir, id, patch) {
  jobId(id);
  safeData(patch);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      Object.keys(patch).some(key => IMMUTABLE.has(key))) throw new Error('immutable job field or invalid patch');
  return lockedJob(storeDir, id, () => {
    const old = existingJob(storeDir, id);
    if (patch.verdict !== undefined) recordVerdictUnlocked(storeDir, id, patch.verdict);
    const { verdict: _verdict, ...storedPatch } = patch;
    const { verdict: _oldVerdict, ...storedOld } = old;
    const next = { ...storedOld, ...storedPatch, updatedAt: new Date().toISOString() };
    safeData(next);
    atomic(location(storeDir, 'jobs', `${id}.yaml`), next);
    return existingJob(storeDir, id);
  });
}

export function requestCancel(storeDir, id, expectedName) {
  const action = () => {
    const job = existingJob(storeDir, jobId(id));
    if (expectedName && (job.name !== expectedName || !ACTIVE.has(job.status))) throw new Error(`no active job named ${expectedName}`);
    const path = location(storeDir, 'cancels', `${id}.yaml`);
    try { atomic(path, { id, requestedAt: new Date().toISOString() }, { exclusive: true }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      statNoFollow(path);
    }
  };
  return lockedJob(storeDir, jobId(id), action);
}
export function isCancelRequested(storeDir, id) {
  jobId(id);
  return statNoFollow(location(storeDir, 'cancels', `${id}.yaml`)) !== null;
}

export function touchOwner(storeDir, owner) {
  ownerId(owner);
  atomic(location(storeDir, 'owners', `${owner}.yaml`), { ownerId: owner, touchedAt: Date.now(), closed: false });
}
export function closeOwner(storeDir, owner) {
  ownerId(owner);
  atomic(location(storeDir, 'owners', `${owner}.yaml`), { ownerId: owner, touchedAt: Date.now(), closed: true });
}
export function ownerAlive(storeDir, owner, { now = Date.now(), leaseMs = 15000 } = {}) {
  ownerId(owner);
  if (!Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs < 0) throw new Error('invalid lease');
  try {
    const lease = yamlRead(location(storeDir, 'owners', `${owner}.yaml`));
    return lease?.ownerId === owner && lease.closed === false &&
      Number.isFinite(lease.touchedAt) && now - lease.touchedAt <= leaseMs;
  } catch { return false; }
}

export function readJobOutput(storeDir, id, { maxBytes = 16000 } = {}) {
  existingJob(storeDir, jobId(id));
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid maxBytes');
  const bytes = readPrivate(location(storeDir, 'output', `${id}.log`));
  if (!bytes || maxBytes === 0) return '';
  return utf8Tail(bytes.subarray(Math.max(0, bytes.length - maxBytes)));
}
export function appendJobOutput(storeDir, id, text) {
  existingJob(storeDir, jobId(id));
  if (typeof text !== 'string') throw new Error('invalid output text');
  const path = location(storeDir, 'output', `${id}.log`);
  const previous = readPrivate(path) ?? Buffer.alloc(0);
  const combined = Buffer.concat([previous, Buffer.from(text)]);
  const tail = Buffer.from(utf8Tail(combined.subarray(Math.max(0, combined.length - OUTPUT_LIMIT))));
  atomic(path, tail);
}

export function writeNotice(storeDir, { ownerId: owner, jobId: id, message, kind } = {}) {
  ownerId(owner); jobId(id);
  if (typeof message !== 'string' || typeof kind !== 'string' || !kind) throw new Error('invalid notice');
  const dir = directory(join(folder(storeDir, 'notices'), owner));
  const notice = { ownerId: owner, jobId: id, message, kind, createdAt: new Date().toISOString() };
  atomic(join(dir, `${randomUUID()}.yaml`), notice, { exclusive: true });
}
export function readNotices(storeDir, owner) {
  ownerId(owner);
  const dir = directory(join(folder(storeDir, 'notices'), owner));
  return readdirSync(dir).filter(name => UUID.test(name.slice(0, -5)) && name.endsWith('.yaml'))
    .flatMap(name => {
      try {
        const notice = yamlRead(join(dir, name));
        return notice?.ownerId === owner && UUID.test(notice.jobId ?? '') &&
          typeof notice.message === 'string' && typeof notice.kind === 'string' ? [{ ...notice, id: name.slice(0, -5) }] : [];
      } catch { return []; }
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
