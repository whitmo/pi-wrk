import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/store.mjs';

const { createExtension } = await createJiti(import.meta.url).import('../extensions/index.ts');

function harness({ startup = () => Promise.resolve(), parser, realStore } = {}) {
  const commands = new Map();
  const events = new Map();
  const jobs = new Map();
  const notices = [];
  const ui = [];
  let serial = 0;
  let owner = 'session-1';
  let busy = false;
  let aborted = 0;
  let starts = 0;
  let heartbeat;
  const branch = [{ id: 'prompt-1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Unfinished request' }] } }];
  const ctx = {
    cwd: '/project', mode: 'tui', hasUI: true,
    ui: { notify: (message, type) => ui.push({ message, type }), setStatus: (key, value) => ui.push({ key, value }) },
    sessionManager: { getSessionId: () => owner, getBranch: () => branch },
    isIdle: () => !busy, get signal() { return busy ? new AbortController().signal : undefined; },
    abort: () => { aborted++; },
    waitForIdle: () => { throw new Error('foreground wait forbidden'); },
  };
  const deps = {
    parseRequest: parser ?? ((text, { alias }) => ({ runner: alias === '&' ? 'router' : 'agent', prompt: text.trim(), options: {}, queue: null, lifetime: 'session', handoff: !text.trim() })),
    storePath: () => '/project/.agents/wrk',
    admitJob: (_, input) => {
      const job = { id: `job-${++serial}`, status: 'queued', ...input };
      jobs.set(job.id, job);
      return job;
    },
    listJobs: () => [...jobs.values()],
    getJob: (_, id) => { if (!jobs.has(id)) throw new Error(`unknown job ${id}`); return jobs.get(id); },
    updateJob: (_, id, patch) => Object.assign(jobs.get(id), patch),
    requestCancel: (_, id) => { if (!jobs.has(id)) throw new Error('unknown job'); jobs.get(id).cancelRequested = true; },
    readJobOutput: (_, id) => `output ${id}`,
    readNotices: () => notices,
    writeNotice: (_, notice) => notices.push(notice),
    touchOwner: (_, id) => ui.push({ touched: id }),
    closeOwner: (_, id) => ui.push({ closed: id }),
    ensureWorker: () => { starts++; return startup(); },
    projectRoot: () => '/project',
    setInterval: (callback) => { heartbeat = callback; return { unref() {} }; },
    clearInterval: () => {},
    newOwnerId: () => `owner-${owner}`,
  };
  if (realStore) Object.assign(deps, store, { storePath: () => realStore });
  const pi = { registerCommand: (name, config) => commands.set(name, config.handler), on: (name, handler) => events.set(name, handler) };
  createExtension(pi, deps);
  const command = (name, input = '') => commands.get(name)(input, ctx);
  const event = (name, payload = {}, context = ctx) => events.get(name)?.(payload, context);
  return { command, event, ctx, jobs, ui, branch, notices, tick: () => heartbeat?.(), get starts() { return starts; }, get aborted() { return aborted; }, busy: (value) => { busy = value; }, session: (value) => { owner = value; } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('submission persists current focus before queueing and respects later clear and opt-out', async t => {
  const { entry } = await import('./fixtures/focus.mjs');
  const { parseRequest } = await import('../src/request.mjs');
  const root = mkdtempSync(join(tmpdir(), 'wrk-focus-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = store.storePath(root);
  const h = harness({ realStore: dir, parser: parseRequest });
  await h.event('session_start');
  const binding = entry();
  h.branch.push(binding);
  await h.command('bg', 'first');
  binding.data.active.focus.goals = 'Later goals';
  await h.command('bg', '--focus none second');
  h.branch.push(entry(null));
  await h.command('bg', 'third');
  const jobs = store.listJobs(dir);
  assert.equal(jobs.find(j => j.request.prompt === 'first').focus.active.focus.goals, 'Ship small changes');
  assert.equal(jobs.find(j => j.request.prompt === 'second').focus, undefined);
  assert.equal(jobs.find(j => j.request.prompt === 'third').focus, undefined);
  await h.command('bg', '--focus active fourth');
  assert.equal(store.listJobs(dir).length, 3);
  assert.match(h.ui.at(-1).message, /active focus/i);
});

test('busy primary admits /bg durably without waiting, aborting, or sending foreground input', async () => {
  const h = harness({ startup: () => new Promise(() => {}) });
  h.busy(true);
  await h.event('session_start');
  await h.command('bg', 'fix report');
  const [job] = h.jobs.values();
  assert.equal(job.request.prompt, 'fix report');
  assert.equal(job.request.lifetime, 'session');
  assert.equal(job.ownerId, 'owner-session-1');
  assert.equal(job.projectRoot, '/project');
  assert.equal(h.starts, 1);
  assert.equal(h.aborted, 0);
  assert.match(h.ui.at(-1).message, /queued.*session/i);
});

test('/wrk queues inspects persistent queue definitions without submitting work', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-queue-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = store.storePath(root);
  store.admitJob(dir, { ownerId: 'other-owner', projectRoot: root, cwd: root,
    request: { runner: 'agent', prompt: 'inspect', options: {}, queue: 'review', lifetime: 'independent' } });
  const h = harness({ realStore: dir });
  await h.event('session_start');
  await h.command('wrk', 'queues');
  assert.equal(h.ui.at(-1).message, 'review');
  assert.equal(h.starts, 0);
  assert.equal(store.listJobs(dir).length, 1);
});

test('heartbeat delivers durable questions once without foreground work or stale-session UI', async () => {
  const h = harness();
  await h.event('session_start');
  h.notices.push({ id: 'notice-1', jobId: 'job-1', message: 'Which config should I use?', kind: 'question' });
  h.tick(); h.tick();
  assert.equal(h.ui.filter(item => item.message?.includes('Which config')).length, 1);
  assert.equal(h.starts, 0);
  h.session('new-session');
  h.notices.push({ id: 'notice-2', jobId: 'job-1', message: 'stale-session-question', kind: 'question' });
  h.tick();
  assert.equal(h.ui.some(item => item.message?.includes('stale-session-question')), false);
  assert.equal(h.notices.length, 2);
});

test('startup failure is visible on status and a durable notice, not reported as running', async () => {
  const h = harness({ startup: () => Promise.reject(new Error('worker failed to bind')) });
  await h.event('session_start');
  await h.command('&', 'check');
  await flush();
  assert.equal(h.jobs.values().next().value.status, 'queued');
  await h.command('wrk', 'status job-1');
  assert.match(h.ui.at(-1).message, /worker failed to bind/);
  assert.doesNotMatch(h.ui.at(-1).message, /running/i);
});

test('/wrk routes inspection and cancellation without admitting another job', async () => {
  const h = harness();
  await h.event('session_start');
  await h.command('&', 'audit');
  await h.command('wrk', 'jobs');
  assert.match(h.ui.at(-1).message, /job-1.*queued/);
  await h.command('wrk', 'output job-1');
  assert.match(h.ui.at(-1).message, /output job-1/);
  await h.command('wrk', 'cancel job-1');
  assert.equal(h.jobs.get('job-1').cancelRequested, true);
  assert.equal(h.jobs.size, 1);
  assert.equal(h.jobs.get('job-1').status, 'queued');
});

test('session owner rotates on replacement and old session closes; independent request has no owner', async () => {
  const h = harness();
  await h.event('session_start');
  await h.command('bg', 'first');
  await h.event('session_shutdown', { reason: 'new' });
  h.session('session-2');
  await h.event('session_start', { reason: 'new' });
  await h.command('bg', 'second');
  assert.equal(h.jobs.get('job-1').ownerId, 'owner-session-1');
  assert.equal(h.jobs.get('job-2').ownerId, 'owner-session-2');
  assert.ok(h.ui.some((item) => item.closed === 'owner-session-1'));
});

test('independent lifetime retains origin owner for notices without tying execution to lease', async () => {
  const h = harness({ parser: (prompt) => ({ runner: 'agent', prompt, options: {}, queue: null, lifetime: 'independent', handoff: false }) });
  await h.event('session_start');
  await h.command('bg', 'persist');
  assert.equal(h.jobs.get('job-1').ownerId, 'owner-session-1');
  assert.equal(h.jobs.get('job-1').request.lifetime, 'independent');
  assert.match(h.ui.at(-1).message, /independent/);
});

test('reconnected status surfaces durable worker notices for original owner', async () => {
  const h = harness();
  await h.event('session_start');
  await h.command('bg', 'inspect');
  h.notices.push({ ownerId: 'owner-session-1', jobId: 'job-1', kind: 'error', message: 'runner exited unexpectedly' });
  await h.command('wrk', 'status job-1');
  assert.match(h.ui.at(-1).message, /runner exited unexpectedly/);
});

test('bare /bg snapshots unfinished request, aborts, and only releases after aborted settle', async () => {
  const h = harness();
  h.busy(true);
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'Unfinished request' });
  await h.command('bg');
  const job = h.jobs.get('job-1');
  assert.equal(h.aborted, 1);
  assert.equal(job.handoff.ready, false);
  assert.equal(job.handoff.snapshot.entryId, 'prompt-1');
  assert.equal(job.request.prompt, 'Unfinished request');
  await h.event('agent_before_settle', { outcome: 'aborted' });
  assert.equal(job.handoff.ready, false);
  h.busy(false);
  await h.event('agent_settled');
  assert.equal(job.handoff.ready, true);
});

test('bare handoff blocks rather than replay after a completed turn or a tool call', async () => {
  const completed = harness();
  await completed.event('session_start');
  await completed.command('&');
  assert.equal(completed.jobs.size, 0);
  assert.match(completed.ui.at(-1).message, /unfinished/i);

  const h = harness();
  h.busy(true);
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'Unfinished request' });
  await h.event('tool_call', { toolName: 'bash' });
  await h.command('&');
  assert.equal(h.aborted, 0);
  assert.equal(h.jobs.size, 0);
  assert.match(h.ui.at(-1).message, /tool/i);
});

test('completed activity is never submitted again while settle event is outstanding', async () => {
  const h = harness();
  h.busy(true);
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'Unfinished request' });
  await h.event('agent_before_settle', { outcome: 'completed' });
  await h.command('bg');
  assert.equal(h.jobs.size, 0);
  assert.equal(h.aborted, 0);
  assert.match(h.ui.at(-1).message, /completed|finished/i);
});

test('real YAML store persists safe handoff readiness after aborted settle', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-wrk-extension-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = harness({ realStore: join(dir, '.agents', 'wrk') });
  h.busy(true);
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'Unfinished request' });
  await h.command('bg');
  const [admitted] = store.listJobs(join(dir, '.agents', 'wrk'));
  assert.equal(admitted.handoff.ready, false);
  await h.event('agent_before_settle', { outcome: 'aborted' });
  h.busy(false);
  await h.event('agent_settled');
  const persisted = store.getJob(join(dir, '.agents', 'wrk'), admitted.id);
  assert.equal(persisted.handoff.ready, true);
  assert.equal(persisted.handoff.reason, undefined);
});

test('real store blocks handoff if session switches before settlement', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-wrk-extension-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const location = join(dir, '.agents', 'wrk');
  const h = harness({ realStore: location });
  h.busy(true);
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'Unfinished request' });
  await h.command('bg');
  const [admitted] = store.listJobs(location);
  h.session('session-2');
  await h.event('session_start', { reason: 'new' });
  const persisted = store.getJob(location, admitted.id);
  assert.equal(persisted.handoff.ready, false);
  assert.match(persisted.handoff.reason, /session changed/i);
  const oldCtx = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => 'session-1' } };
  await h.event('session_shutdown', { reason: 'old' }, oldCtx);
  await h.command('bg', 'next task');
  assert.equal(store.listJobs(location).length, 2);
  assert.ok(store.ownerAlive(location, 'owner-session-2'));
});

test('handoff stays blocked on uncertain settlement and never reuses stale session UI', async () => {
  const h = harness();
  h.busy(true);
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'Unfinished request' });
  await h.command('&');
  await h.event('agent_before_settle', { outcome: 'completed' });
  h.busy(false);
  await h.event('agent_settled');
  assert.equal(h.jobs.get('job-1').handoff.ready, false);
  assert.match(h.ui.at(-1).message, /blocked/i);
  const prior = h.ui.length;
  await h.event('session_shutdown', { reason: 'new' });
  h.session('session-2');
  await h.event('session_start', { reason: 'new' });
  assert.equal(h.ui.length > prior, true);
});
