import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/store.mjs';

const { createExtension } = await createJiti(import.meta.url).import('../extensions/index.ts');

function harness({ startup = () => Promise.resolve(), parser, realStore, outputFailure, readZellijTab, zellijSessionName, zellijPaneId, collectFileMessages, initialBranch, sharedJobs, cleanupAt7Workspace, admissionFailure, delayTranscript = false, peerRegister, ownerFactory } = {}) {
  const commands = new Map();
  const events = new Map();
  const bus = new Map();
  const jobs = sharedJobs ?? new Map();
  const output = new Map();
  const notices = [];
  const ui = [];
  let serial = 0;
  let owner = 'session-1';
  let busy = false;
  let aborted = 0;
  let starts = 0;
  let heartbeat;
  let watchTick;
  const messages = [];
  const transcript = [];
  const branch = initialBranch ?? [{ id: 'prompt-1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Unfinished request' }] } }];
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
      if (admissionFailure) throw new Error(admissionFailure);
      const job = { id: `job-${++serial}`, status: input.initialStatus ?? 'queued', ...input };
      jobs.set(job.id, job);
      return job;
    },
    listJobs: () => [...jobs.values()],
    getJob: (_, id) => { if (!jobs.has(id)) throw new Error(`unknown job ${id}`); return jobs.get(id); },
    updateJob: (_, id, patch) => Object.assign(jobs.get(id), patch),
    requestCancel: (_, id) => { if (!jobs.has(id)) throw new Error('unknown job'); jobs.get(id).cancelRequested = true; },
    readJobOutput: (_, id) => output.get(id) ?? `output ${id}`,
    appendJobOutput: (_, id, text) => {
      if (outputFailure) throw new Error(outputFailure);
      output.set(id, `${output.get(id) ?? ''}${text}`);
    },
    readNotices: () => notices,
    writeNotice: (_, notice) => notices.push(notice),
    touchOwner: (_, id) => ui.push({ touched: id }),
    closeOwner: (_, id) => ui.push({ closed: id }),
    ensureWorker: () => { starts++; return startup(); },
    projectRoot: () => '/project',
    setInterval: (callback, ms) => {
      const timer = { cleared: false, unref() {} };
      const tick = () => { if (!timer.cleared) callback(); };
      if (ms === 5000) heartbeat = tick;
      if (ms === 1000) watchTick = tick;
      return timer;
    },
    clearInterval: (timer) => { timer.cleared = true; },
    newOwnerId: ownerFactory ?? (() => `owner-${owner}`),
    readZellijTab: readZellijTab ?? (async () => { throw new Error('No Zellij test fixture'); }),
    zellijSessionName: zellijSessionName ?? (() => 'agent-zellij'),
    zellijPaneId: zellijPaneId ?? (() => 42),
    collectFileMessages: collectFileMessages ?? (async () => []),
    createAt7Workspace: () => ({ projectRoot: '/triage', cwd: '/triage', branch: 'wrk/at7-test' }),
    cleanupAt7Workspace: cleanupAt7Workspace ?? (() => true),
  };
  if (realStore) Object.assign(deps, store, { storePath: () => realStore });
  const pi = { registerCommand: (name, config) => commands.set(name, config.handler), on: (name, handler) => events.set(name, handler), events: { on: (name, handler) => bus.set(name, handler), emit: (name, payload) => { if (name === 'intercom:extension-register') peerRegister?.(payload); bus.get(name)?.(payload); } }, sendUserMessage: (message, options) => messages.push({ message, options }), appendEntry: (customType, data) => branch.push({ id: `entry-${branch.length}`, type: 'custom', customType, data }), sendMessage: (message, options) => { transcript.push({ message, options }); if (!delayTranscript) branch.push({ type: 'message', message: { role: 'custom', ...message } }); } };
  createExtension(pi, deps);
  const command = (name, input = '') => commands.get(name)(input, ctx);
  const event = (name, payload = {}, context = ctx) => events.get(name)?.(payload, context);
  return { command, event, onBus: (name, handler) => bus.set(name, handler), ctx, jobs, ui, branch, notices, messages, transcript, tick: () => heartbeat?.(), tickWatch: async () => { watchTick?.(); await flush(); }, get starts() { return starts; }, get aborted() { return aborted; }, busy: (value) => { busy = value; }, session: (value) => { owner = value; } };
}


const flush = () => new Promise(resolve => setImmediate(resolve));

test('next turn admits one @@7 job per key; reload and repeat keep it seen', async () => {
  const item = { key: 'file:test:1:question', source: 'file', location: 'test.ts:1', text: 'question?' };
  const scopes = [];
  const collect = async (root, scope) => { assert.equal(root, '/project'); scopes.push(scope); return [item]; };
  const h = harness({ collectFileMessages: collect });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'ordinary request' });
  assert.equal(h.jobs.size, 1);
  const job = [...h.jobs.values()][0];
  assert.equal(job.ownerId, 'owner-session-1');
  assert.equal(job.cwd, '/triage');
  assert.equal(job.projectRoot, '/triage');
  assert.match(job.request.prompt, /test.ts:1[\s\S]*question\?/);
  assert.match(job.request.prompt, /dirty|uncommitted/i);
  assert.match(job.request.prompt, /worktree/i);
  await h.event('before_agent_start', { prompt: 'another request' });
  assert.equal(h.jobs.size, 1);
  const reload = harness({ collectFileMessages: collect, initialBranch: h.branch });
  await reload.event('session_start');
  await reload.event('before_agent_start', { prompt: 'after reload' });
  assert.equal(reload.jobs.size, 0);
  await reload.command('wrk', 'at7 scan --all');
  assert.equal(reload.jobs.size, 0);
  assert.deepEqual(scopes, ['changed', 'changed', 'changed', 'all']);
});

test('failed bash new-tab never makes an unrelated tab eligible', async () => {
  const reads = [];
  const h = harness({ readZellijTab: async (_, selector) => { reads.push(selector); return { tabId: 2, snapshot: '@@7 unrelated' }; } });
  await h.event('session_start');
  const input = { command: 'zellij action new-tab --name existing' };
  await h.event('tool_call', { toolName: 'bash', input });
  await h.event('tool_result', { toolName: 'bash', input, isError: true });
  await h.event('tool_result', { toolName: 'bash', input: { command: 'zellij action new-tab --name existing-too' }, details: { exitCode: 1 }, isError: false });
  await h.event('before_agent_start', { prompt: 'continue' });
  assert.deepEqual(reads, []);
  assert.equal(h.jobs.size, 0);
});

test('successful named Zellij tools register created tabs, but non-tab placement does not', async () => {
  const reads = [];
  const h = harness({ readZellijTab: async (_, selector) => { reads.push(selector.tabName); return { tabId: reads.length, snapshot: '@@7 from tool' }; } });
  await h.event('session_start');
  await h.event('tool_result', { toolName: 'zellij_open_terminal', input: { placement: 'tab', tab_name: 'build' }, isError: false });
  await h.event('tool_result', { toolName: 'zellij_start_pi', input: { placement: 'pane', tab_name: 'ignored' }, details: { tab_name: 'ignored' }, isError: false });
  await h.event('tool_result', { toolName: 'zellij_start_pi', input: { placement: 'tab' }, details: { tab_name: 'remote', session_name: 'other-session' }, isError: false });
  await h.event('before_agent_start', { prompt: 'continue' });
  assert.deepEqual(reads, ['build']);
  assert.equal(h.jobs.size, 1);
});

test('zellij_start_pi tab result registers named tabs and an existing-tab result baselines', async () => {
  const screens = { pi: '@@7 pi ready', existing: '@@7 old\n' };
  const reads = [];
  const h = harness({ readZellijTab: async (_, selector) => { const name = selector.tabName ?? (selector.tabId === 1 ? 'pi' : 'existing'); reads.push(name); return { tabId: name === 'pi' ? 1 : 2, snapshot: screens[name] }; } });
  await h.event('session_start');
  await h.event('tool_result', { toolName: 'zellij_start_pi', input: { placement: 'tab' }, details: { tab_name: 'pi' }, isError: false });
  await h.event('tool_result', { toolName: 'zellij_open_terminal', input: { placement: 'tab' }, details: { tab_name: 'existing', created: false }, isError: false });
  screens.existing += '@@7 new\n';
  await h.event('before_agent_start', { prompt: 'continue' });
  assert.deepEqual([...h.jobs.values()].map(job => job.request.prompt.match(/pi ready|new/)[0]), ['pi ready', 'new']);
  assert.deepEqual(reads, ['existing', 'pi', 'existing']);
});

test('Pi-mediated Zellij commands with an explicit session still identify named tabs', async () => {
  const h = harness({ readZellijTab: async () => ({ tabId: 2, snapshot: '@@7 session option' }) });
  await h.event('session_start');
  await h.event('tool_call', { toolName: 'bash', input: { command: 'zellij --session agent-zellij action new-tab --name build' } });
  await h.event('tool_result', { toolName: 'bash', input: { command: 'zellij --session agent-zellij action new-tab --name build' }, isError: false });
  await h.event('before_agent_start', { prompt: 'continue' });
  assert.equal(h.jobs.size, 1);
  await h.event('tool_call', { toolName: 'bash', input: { command: 'zellij --session someone-else action new-tab --name other' } });
  await h.event('before_agent_start', { prompt: 'again' });
  assert.equal(h.jobs.size, 1);
});

test('terminal intake never scans when the owning Pi pane is unidentified', async () => {
  const h = harness({ zellijPaneId: () => undefined, readZellijTab: async () => ({ tabId: 2, snapshot: '@@7 private Pi pane' }) });
  await h.event('session_start');
  await h.event('tool_call', { toolName: 'bash', input: { command: 'zellij action new-tab --name candidate' } });
  await h.event('tool_result', { toolName: 'bash', input: { command: 'zellij action new-tab --name candidate' }, isError: false });
  await h.event('before_agent_start', { prompt: 'ordinary' });
  assert.equal(h.jobs.size, 0);
});

test('tool-created eligible tab is scanned on next turn; unrelated selected tab is never read', async () => {
  const reads = [];
  const h = harness({ readZellijTab: async (_, selector) => { reads.push(selector.tabName); return { tabId: 2, snapshot: '@@7 terminal ask' }; } });
  await h.event('session_start');
  await h.event('tool_call', { toolName: 'bash', input: { command: 'zellij action new-tab --name build' } });
  await h.event('tool_result', { toolName: 'bash', input: { command: 'zellij action new-tab --name build' }, isError: false });
  await h.event('before_agent_start', { prompt: 'look' });
  assert.equal(h.jobs.size, 1);
  assert.deepEqual(reads, ['build']);
  assert.match([...h.jobs.values()][0].request.prompt, /terminal ask/);
});

test('independent @@7 job survives same-session reload, reports once and never redispatches', async () => {
  const item = { key: 'key-persist', source: 'file', location: 'src/a.ts:1', text: 'question' };
  const collect = async () => [item];
  const h = harness({ collectFileMessages: collect });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'first' });
  const job = [...h.jobs.values()][0];
  assert.equal(job.request.lifetime, 'independent');
  assert.equal(h.branch.some(entry => entry.customType === 'wrk-at7-journal' && entry.data?.jobId === job.id), true);
  const reload = harness({ collectFileMessages: collect, initialBranch: h.branch, sharedJobs: h.jobs });
  await reload.event('session_start');
  job.status = 'succeeded'; job.summary = 'answered across reload';
  reload.tick();
  assert.equal(reload.transcript.length, 1);
  assert.match(reload.transcript[0].message.content, /answered across reload/);
  assert.equal(reload.transcript[0].options.triggerTurn, false);
  await reload.event('before_agent_start', { prompt: 'again' });
  assert.equal(reload.jobs.size, 1);
  const next = harness({ collectFileMessages: collect, initialBranch: reload.branch, sharedJobs: reload.jobs });
  await next.event('session_start');
  next.tick();
  assert.equal(next.transcript.length, 0);
  await next.event('before_agent_start', { prompt: 'again' });
  assert.equal(next.jobs.size, 1);
});

test('deferred transcript result is never marked delivered until the message is persisted', async () => {
  const item = { key: 'deferred', source: 'file', location: 'a:1', text: 'help' };
  const collect = async () => [item];
  const h = harness({ collectFileMessages: collect, delayTranscript: true });
  await h.event('session_start'); await h.event('before_agent_start', { prompt: 'request' });
  const job = [...h.jobs.values()][0]; job.status = 'succeeded'; job.summary = 'answered';
  h.tick(); h.tick();
  assert.equal(h.transcript.length, 1);
  assert.equal(h.branch.some(entry => entry.customType === 'wrk-at7-journal' && entry.data?.state === 'delivered'), false);
  const reload = harness({ initialBranch: h.branch, sharedJobs: h.jobs, collectFileMessages: collect });
  await reload.event('session_start'); reload.tick();
  assert.equal(reload.transcript.length, 1);
});

test('reload recognizes an already-persisted transcript result even if its delivered journal entry was interrupted', async () => {
  const h = harness({ collectFileMessages: async () => [{ key: 'interrupted-delivery', source: 'file', location: 'a:1', text: 'help' }] });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'request' });
  const job = [...h.jobs.values()][0];
  job.status = 'succeeded'; job.summary = 'answered';
  h.branch.push({ type: 'message', message: { role: 'custom', customType: 'wrk-at7', details: { jobId: job.id } } });
  const reload = harness({ initialBranch: h.branch, sharedJobs: h.jobs });
  await reload.event('session_start');
  reload.tick();
  assert.equal(reload.transcript.length, 0);
  assert.equal(reload.branch.some(entry => entry.customType === 'wrk-at7-journal' && entry.data?.state === 'cleaned'), true);
});

test('failed independent triage after reload reports error once without an old-owner notice', async () => {
  const item = { key: 'failure-reload', source: 'file', location: 'a:1', text: 'help' };
  const collect = async () => [item];
  const h = harness({ collectFileMessages: collect });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'first' });
  const reload = harness({ initialBranch: h.branch, sharedJobs: h.jobs, collectFileMessages: collect });
  await reload.event('session_start');
  const job = [...reload.jobs.values()][0];
  job.status = 'failed'; job.error = 'triage failed';
  reload.tick(); reload.tick();
  assert.equal(reload.transcript.length, 1);
  assert.match(reload.transcript[0].message.content, /triage failed/);
  assert.equal(reload.transcript[0].options.triggerTurn, false);
});

test('failed admission cleans its unused worktree and leaves message unseen', async () => {
  const cleaned = [];
  const h = harness({ admissionFailure: 'store unavailable', collectFileMessages: async () => [{ key: 'retry', source: 'file', location: 'a:1', text: 'retry me' }], cleanupAt7Workspace: (root, path) => { cleaned.push([root, path]); return true; } });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'request' });
  assert.deepEqual(cleaned, [['/project', '/triage']]);
  assert.equal(h.branch.some(entry => entry.customType === 'wrk-at7-journal'), false);
  assert.equal(h.ui.some(entry => /store unavailable/.test(entry.message ?? '')), true);
});

test('finished @@7 jobs clean idle worktrees once, but preserve dirty worktrees', async () => {
  const item = { key: 'k-cleanup', source: 'file', location: 'a:1', text: 'action' };
  const cleaned = [];
  const h = harness({ collectFileMessages: async () => [item], cleanupAt7Workspace: (root, path) => { cleaned.push([root, path]); return false; } });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'request' });
  const job = [...h.jobs.values()][0];
  h.tick(); assert.deepEqual(cleaned, []); // running/queued jobs cannot lose their worktrees
  job.status = 'failed'; job.error = 'triage unavailable';
  h.tick(); h.tick();
  assert.deepEqual(cleaned, [['/project', '/triage']]);
  assert.match(h.transcript[0].message.content, /triage unavailable/);
  assert.equal(h.ui.some(entry => /retained.*uncommitted/.test(entry.message ?? '')), true);
});

test('session switch during async collection drops old intake without recording seen', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  let collecting = false;
  const h = harness({ collectFileMessages: async () => { collecting = true; await slow; return [{ key: 'k', source: 'file', location: 'a:1', text: 'ask' }]; } });
  await h.event('session_start');
  const first = h.event('before_agent_start', { prompt: 'first' });
  assert.equal(collecting, true);
  h.session('other');
  await h.event('session_start');
  release(); await first;
  assert.equal(h.jobs.size, 0);
  assert.equal(h.branch.some(entry => entry.customType === 'wrk-at7-seen'), false);
});

test('triage notice displays bounded success or failure in transcript without waking the agent', async () => {
  const item = { key: 'k', source: 'file', location: 'a:1', text: 'ask' };
  const h = harness({ collectFileMessages: async () => [item] });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'request' });
  const job = [...h.jobs.values()][0];
  h.jobs.get(job.id).status = 'succeeded';
  h.jobs.get(job.id).summary = 'answered the question';
  h.notices.push({ id: 'note-1', jobId: job.id, message: 'completed', kind: 'succeeded' });
  h.tick();
  assert.equal(h.transcript.length, 1);
  assert.equal(h.transcript[0].options.triggerTurn, false);
  assert.match(h.transcript[0].message.content, /answered the question/);
  assert.equal(h.messages.length, 0);
  h.tick(); assert.equal(h.transcript.length, 1);
  h.notices.push({ id: 'note-2', jobId: job.id, message: 'failed to act', kind: 'failed' });
  h.tick(); assert.equal(h.transcript.length, 1);
  const reload = harness({ initialBranch: h.branch });
  await reload.event('session_start');
  reload.jobs.set(job.id, job);
  reload.notices.push({ id: 'note-reload', jobId: job.id, message: 'result retained', kind: 'succeeded' });
  reload.tick();
  assert.equal(reload.transcript.length, 0);
});

test('explicit visit baselines immediately, so output arriving before next turn is delivered', async () => {
  let screen = '@@7 old';
  const h = harness({ readZellijTab: async () => ({ tabId: 9, snapshot: screen }) });
  await h.event('session_start');
  await h.command('wrk', 'at7 tab my-tab');
  screen += '\n@@7 after visit';
  await h.event('before_agent_start', { prompt: 'continue' });
  assert.equal(h.jobs.size, 1);
  assert.match([...h.jobs.values()][0].request.prompt, /after visit/);
});

test('Pi-mediated tab visit baselines at completed tool call', async () => {
  let screen = '@@7 old';
  const h = harness({ readZellijTab: async () => ({ tabId: 9, snapshot: screen }) });
  await h.event('session_start');
  await h.event('tool_call', { toolName: 'bash', input: { command: 'zellij action go-to-tab-name visited' } });
  await h.event('tool_result', { toolName: 'bash', input: { command: 'zellij action go-to-tab-name visited' }, isError: false });
  screen += '\n@@7 next';
  await h.event('before_agent_start', { prompt: 'continue' });
  assert.equal(h.jobs.size, 1);
  assert.match([...h.jobs.values()][0].request.prompt, /next/);
});

test('file messages still admit when a registered tab fails to read', async () => {
  const item = { key: 'file:question', source: 'file', location: 'a:1', text: 'answer me' };
  const h = harness({ collectFileMessages: async () => [item], readZellijTab: async () => { throw new Error('tab closed'); } });
  await h.event('session_start');
  await h.event('tool_call', { toolName: 'bash', input: { command: 'zellij action new-tab --name closed' } });
  await h.event('tool_result', { toolName: 'bash', input: { command: 'zellij action new-tab --name closed' }, isError: false });
  await h.event('before_agent_start', { prompt: 'continue' });
  assert.equal(h.jobs.size, 1);
  assert.match([...h.jobs.values()][0].request.prompt, /answer me/);
  assert.equal(h.ui.some(entry => /tab closed/.test(entry.message ?? '')), true);
});

test('explicit at7 tab registration does not start a watch or wake an idle session', async () => {
  const h = harness({ readZellijTab: async () => ({ tabId: 9, snapshot: '@@7 old' }) });
  await h.event('session_start');
  await h.command('wrk', 'at7 tab my-tab');
  assert.match(h.ui.at(-1).message, /my-tab/);
  assert.equal(h.messages.length, 0);
  assert.equal(h.jobs.size, 0);
});

test('Zellij watch wakes once on a later tab screen change, not on unchanged polls', async () => {
  let screen = 'initial';
  const reads = [];
  const h = harness({ readZellijTab: async (session, selection) => {
    reads.push({ session, selection });
    return { tabId: 9, snapshot: screen };
  } });
  await h.event('session_start');
  await h.command('watch:zellij', 'term');
  assert.match(h.ui.at(-1).message, /watching.*term/i);
  assert.deepEqual(reads[0], { session: 'agent-zellij', selection: { tabName: 'term', ownPaneId: 42 } });
  screen = 'fresh output before first poll';
  h.busy(true); // streaming or compaction: do not lose an early wake
  await h.tickWatch();
  assert.equal(h.messages.length, 0);
  h.busy(false);
  await h.tickWatch();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].message, /term.*changed/i);
  assert.equal(h.messages[0].options, undefined);
  await h.tickWatch();
  assert.equal(h.messages.length, 1);
  assert.equal(reads.length, 2);
});

test('Zellij watch replacement, shutdown, and read failures do not wake stale sessions', async () => {
  let screen = 'initial';
  let error;
  const h = harness({ readZellijTab: async (_, selection) => {
    if (error) throw error;
    return { tabId: selection.tabName === 'first' ? 1 : 2, snapshot: screen };
  } });
  await h.event('session_start');
  await h.command('watch:zellij', 'first');
  await h.command('watch:zellij', 'second');
  await h.tickWatch(); // arm after replacement's receipt
  screen = 'changed';
  await h.tickWatch();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].message, /second/);
  await h.command('watch:zellij', 'third');
  h.session('session-2');
  await h.event('session_start');
  screen = 'changed again';
  await h.tickWatch();
  assert.equal(h.messages.length, 1);
  await h.command('watch:zellij', 'fourth');
  error = new Error('Zellij tab missing');
  await h.tickWatch();
  assert.match(h.ui.at(-1).message, /Zellij tab missing/);
  await h.tickWatch();
  assert.equal(h.messages.length, 1);
  error = undefined;
  await h.command('watch:zellij', 'fifth');
  await h.event('session_shutdown');
  screen = 'after shutdown';
  await h.tickWatch();
  assert.equal(h.messages.length, 1);
});

test('slow initial snapshot cannot replace a newer Zellij watch', async () => {
  let finishFirst;
  let screen = 'initial';
  const h = harness({ readZellijTab: async (_, selection) => {
    if (selection.tabName === 'first') return new Promise(resolve => { finishFirst = resolve; });
    return { tabId: 2, snapshot: screen };
  } });
  await h.event('session_start');
  const slow = h.command('watch:zellij', 'first');
  await flush();
  await h.command('watch:zellij', 'second');
  finishFirst({ tabId: 1, snapshot: 'old screen' });
  await slow;
  await h.tickWatch();
  screen = 'changed';
  await h.tickWatch();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].message, /second/);
});

test('Zellij watch rejects invocation outside its owning Zellij session', async () => {
  const h = harness({ zellijSessionName: () => '', readZellijTab: async () => ({ tabId: 1, snapshot: 'first' }) });
  await h.event('session_start');
  await h.command('watch:zellij', 'term');
  assert.match(h.ui.at(-1).message, /Zellij session/i);
  await h.tickWatch();
  assert.equal(h.messages.length, 0);
  const noPane = harness({ zellijPaneId: () => undefined, readZellijTab: async () => ({ tabId: 1, snapshot: 'first' }) });
  await noPane.event('session_start');
  await noPane.command('watch:zellij', 'term');
  assert.match(noPane.ui.at(-1).message, /ZELLIJ_PANE_ID/);
});

test('BTW submission stays in the current session and publishes an inspectable answer', async () => {
  const h = harness();
  h.event('session_start');
  let request;
  h.onBus('pi-wrk:btw-submit', (payload) => { request = payload; payload.accept(); });
  await h.command('wrk', 'btw explain this deployment');
  assert.equal(request.question, 'explain this deployment');
  assert.equal(request.ctx, h.ctx);
  assert.equal(h.starts, 1, 'worker must reconcile this job if the Pi session crashes');
  assert.equal(h.aborted, 0);
  assert.equal(h.jobs.size, 1);
  const job = [...h.jobs.values()][0];
  assert.equal(job.status, 'running');
  assert.equal(job.request.runner, 'btw');
  request.done({ answer: 'Keep the backend stable.' });
  await flush();
  assert.equal(job.status, 'succeeded');
  await h.command('wrk', `output ${job.id}`);
  assert.match(h.ui.at(-1).message, /Keep the backend stable/);
  await h.command('wrk', `status ${job.id}`);
  assert.match(h.ui.at(-1).message, /succeeded/);
});

test('BTW roots have names and become the next conditional predecessor', async t => {
  const { parseRequest } = await import('../src/request.mjs');
  const root = mkdtempSync(join(tmpdir(), 'wrk-btw-chain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = store.storePath(root);
  const h = harness({ realStore: dir, parser: parseRequest });
  h.onBus('pi-wrk:btw-submit', ({ accept }) => accept());
  await h.event('session_start');
  await h.command('wrk', 'btw first question');
  const first = store.listJobs(dir).find(j => j.request.runner === 'btw');
  assert.match(first.name, /^[a-z]+\.[a-z]+\.[0-9]$/);
  await h.command('wrk', `status ${first.name}`);
  assert.match(h.ui.at(-1).message, /running/);
  await h.command('&&', 'after first BTW');
  assert.equal(store.listJobs(dir).find(j => j.request.prompt === 'after first BTW').predecessorId, first.id);
  await h.command('bg', 'normal root');
  await h.command('wrk', 'btw second question');
  const second = store.listJobs(dir).find(j => j.request.prompt === 'second question');
  assert.match(second.name, /^[a-z]+\.[a-z]+\.[0-9]$/);
  await h.command('&&', 'after second BTW');
  assert.equal(store.listJobs(dir).find(j => j.request.prompt === 'after second BTW').predecessorId, second.id);
});

test('BTW answer remains readable from the durable job store', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-btw-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = store.storePath(root);
  const h = harness({ realStore: dir });
  h.event('session_start');
  h.onBus('pi-wrk:btw-submit', ({ accept, done }) => {
    accept();
    done({ answer: 'Durable answer' });
  });
  await h.command('wrk', 'btw explain this deployment');
  await flush();
  const [job] = store.listJobs(dir);
  assert.equal(job.status, 'succeeded');
  assert.match(store.readJobOutput(dir, job.id), /Durable answer/);
  await h.command('wrk', `output ${job.id}`);
  assert.match(h.ui.at(-1).message, /Durable answer/);
});

test('BTW submission fails visibly if BTW is missing or the query fails', async () => {
  const h = harness();
  h.event('session_start');
  await h.command('wrk', 'btw no extension installed');
  const missing = [...h.jobs.values()][0];
  assert.equal(missing.status, 'failed');
  assert.match(missing.error, /pi-btw.*unavailable/i);
  h.onBus('pi-wrk:btw-submit', (request) => { request.accept(); request.done({ error: 'No credentials available' }); });
  await h.command('wrk', 'btw need credentials');
  const failed = [...h.jobs.values()][1];
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /No credentials/);
  await h.command('wrk', `status ${failed.id}`);
  assert.match(h.ui.at(-1).message, /No credentials/);
});

test('BTW output-write failure marks the job failed instead of leaving it running', async () => {
  const h = harness({ outputFailure: 'disk full' });
  h.event('session_start');
  h.onBus('pi-wrk:btw-submit', ({ accept, done }) => {
    accept();
    done({ answer: 'reply' });
  });
  await h.command('wrk', 'btw question');
  const [job] = [...h.jobs.values()];
  assert.equal(job.status, 'failed');
  assert.match(job.error, /disk full/);
});

test('a new session starts reconciliation for an abandoned BTW job', async () => {
  const h = harness();
  h.jobs.set('old-job', { id: 'old-job', status: 'running', request: { runner: 'btw' } });
  h.event('session_start');
  await flush();
  assert.equal(h.starts, 1);
});

test('BTW running job is failed if its owning session closes', async () => {
  const h = harness();
  h.event('session_start');
  let request;
  h.onBus('pi-wrk:btw-submit', (payload) => { request = payload; payload.accept(); });
  await h.command('wrk', 'btw long thought');
  const job = [...h.jobs.values()][0];
  h.event('session_shutdown');
  assert.equal(job.status, 'failed');
  request.done({ answer: 'Late reply' });
  assert.equal(job.status, 'failed', 'late responses must not overwrite a failed job');
});

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
  const h = harness();
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

test('admission waits for worker readiness, including an in-flight startup', async () => {
  let ready;
  const h = harness({ startup: () => new Promise(resolve => { ready = resolve; }) });
  await h.event('session_start');
  const submitting = h.command('bg', 'check');
  assert.equal(h.jobs.size, 0);
  ready();
  await submitting;
  assert.equal(h.jobs.size, 1);
});

test('incompatible live worker prevents admission on command and inline input', async () => {
  const h = harness({ startup: () => Promise.reject(new Error('Worker protocol mismatch: let active jobs drain, stop the old worker, then restart pi-wrk and retry')) });
  await h.event('session_start');
  await h.command('&', 'check');
  assert.equal(h.jobs.size, 0);
  assert.match(h.ui.at(-1).message, /drain.*restart/i);
  assert.deepEqual(await h.event('input', { text: 'check &', source: 'interactive' }), { action: 'handled' });
  assert.equal(h.jobs.size, 0);
  assert.equal(h.starts, 2);
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

test('reload retains the session lease and identity; quit and session replacement close it', async () => {
  const h = harness();
  await h.event('session_start');
  await h.command('bg', 'before reload');
  await h.event('session_shutdown', { reason: 'reload' });
  assert.equal(h.ui.some(item => item.closed === 'owner-session-1'), false);
  await h.event('session_start', { reason: 'reload' });
  await h.command('bg', 'after reload');
  assert.equal(h.jobs.get('job-2').ownerId, h.jobs.get('job-1').ownerId);
  h.tick();
  assert.ok(h.ui.some(item => item.touched === 'owner-session-1'));
  await h.event('session_shutdown', { reason: 'quit' });
  assert.ok(h.ui.some(item => item.closed === 'owner-session-1'));
});

test('real lease survives extension recreation on reload but closes on quit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-reload-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'store');
  const h = harness({ realStore: dir });
  await h.event('session_start');
  await h.command('bg', 'old session job');
  const first = store.listJobs(dir)[0];
  await h.event('session_shutdown', { reason: 'reload' });
  assert.equal(store.ownerAlive(dir, first.ownerId), true);
  const reload = harness({ realStore: dir, initialBranch: h.branch });
  await reload.event('session_start', { reason: 'reload' });
  await reload.command('bg', 'new session job');
  assert.equal(store.listJobs(dir)[0].ownerId, first.ownerId);
  await reload.event('session_shutdown', { reason: 'quit' });
  assert.equal(store.ownerAlive(dir, first.ownerId), false);
  const afterQuit = harness({ realStore: dir, initialBranch: reload.branch, ownerFactory: () => 'owner-after-quit' });
  await afterQuit.event('session_start', { reason: 'reload' });
  await afterQuit.command('bg', 'new owner');
  assert.notEqual(store.listJobs(dir)[0].ownerId, first.ownerId);
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


test('rapid conditional admissions bind only preceding root from same session', async t => {
  const { parseRequest } = await import('../src/request.mjs');
  const root = mkdtempSync(join(tmpdir(), 'wrk-edges-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = store.storePath(root);
  const h = harness({ realStore: dir, parser: parseRequest });
  await h.event('session_start');
  await h.command('bg', 'first');
  await h.command('&&', 'second');
  await h.command('||', 'third');
  await h.command('~&&', 'fourth');
  await h.command('~||', 'fifth');
  const jobs = store.listJobs(dir);
  const find = prompt => jobs.find(job => job.request.prompt === prompt);
  assert.equal(find('second').predecessorId, find('first').id);
  assert.equal(find('third').predecessorId, find('second').id);
  assert.equal(find('fourth').predecessorId, find('third').id);
  assert.equal(find('fifth').predecessorId, find('fourth').id);
  h.session('session-2');
  await h.event('session_start');
  await h.command('&&', 'orphan');
  assert.equal(store.listJobs(dir).length, 5);
  assert.match(h.ui.at(-1).message, /predecessor/i);
  await h.command('bg', 'other');
  await h.command('||', 'other followup');
  assert.equal(store.listJobs(dir).find(j => j.request.prompt === 'other followup').predecessorId,
    store.listJobs(dir).find(j => j.request.prompt === 'other').id);
});

test('composer prefix routes through /& and conditional commands, never the foreground', async () => {
  const { parseRequest } = await import('../src/request.mjs');
  const h = harness({ parser: parseRequest });
  await h.event('session_start');
  assert.deepEqual(await h.event('input', { text: '& first', source: 'interactive' }), { action: 'handled' });
  assert.deepEqual(await h.event('input', { text: '&& second', source: 'interactive' }), { action: 'handled' });
  assert.deepEqual(await h.event('input', { text: '~|| third', source: 'interactive' }), { action: 'handled' });
  assert.equal(h.jobs.size, 3);
  assert.equal(h.jobs.get('job-1').request.runner, 'router');
  assert.equal(h.jobs.get('job-2').request.condition, '&&');
  assert.equal(h.jobs.get('job-2').predecessorId, 'job-1');
  assert.equal(h.jobs.get('job-3').request.condition, '~||');
  assert.deepEqual(await h.event('input', { text: '& ignored', source: 'extension' }), { action: 'continue' });
  assert.equal(h.jobs.size, 3);
});

test('trailing line and explicit markup admit once, transform only remaining foreground', async () => {
  const { parseRequest } = await import('../src/request.mjs');
  const h = harness({ parser: parseRequest });
  await h.event('session_start');
  assert.deepEqual(await h.event('input', { text: 'review code &\nWrite a summary', source: 'interactive' }),
    { action: 'transform', text: 'Write a summary' });
  assert.equal(h.jobs.get('job-1').request.prompt, 'review code');
  assert.deepEqual(await h.event('input', { text: 'Before <& type=swarm model="luna 6 xhigh">build it</&> after', source: 'interactive' }),
    { action: 'transform', text: 'Before  after' });
  assert.equal(h.jobs.get('job-2').request.runner, 'swarm');
  assert.equal(h.jobs.get('job-2').request.prompt, 'build it');
  assert.equal(h.jobs.get('job-2').request.options.model, 'luna 6 xhigh');
  assert.equal(h.jobs.size, 2);
});

test('invalid syntax and failed admission never leak background work into foreground', async () => {
  const { parseRequest } = await import('../src/request.mjs');
  const h = harness({ parser: parseRequest });
  await h.event('session_start');
  assert.deepEqual(await h.event('input', { text: 'Before <& type=swarm model=bad>work</&> after', source: 'interactive' }), { action: 'handled' });
  assert.match(h.ui.at(-1).message, /invalid|malformed/i);
  assert.deepEqual(await h.event('input', { text: '&& no predecessor\nforeground', source: 'interactive' }), { action: 'handled' });
  assert.match(h.ui.at(-1).message, /predecessor/i);
  assert.deepEqual(await h.event('input', { text: 'task &\nforeground', source: 'interactive', images: [{}] }), { action: 'handled' });
  assert.match(h.ui.at(-1).message, /image/i);
  assert.equal(h.jobs.size, 0);
});

test('submission captures selected model and ordered scoped models without replacing request options', async () => {
  const h = harness({ parser: text => ({ runner: 'agent', prompt: text, options: { tools: 'read', model: 'explicit/model' }, queue: null, lifetime: 'session', handoff: false }) });
  h.ctx.model = { provider: 'alpha', id: 'one' };
  h.ctx.scopedModels = [{ model: { provider: 'beta', id: 'two' } }, { model: { provider: 'gamma', id: 'three' } }];
  await h.event('session_start');
  await h.command('bg', 'work');
  assert.deepEqual([...h.jobs.values()][0].request.options, {
    tools: 'read', model: 'explicit/model', defaultModel: 'alpha/one', scopedModels: ['beta/two', 'gamma/three'],
  });
});

test('root names appear beside UUID and resolve only while active; UUID history remains accessible', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-label-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = store.storePath(root);
  const h = harness({ realStore: dir });
  await h.event('session_start');
  await h.command('bg', 'labeled');
  const [job] = store.listJobs(dir);
  assert.match(job.name, /^[a-z]+\.[a-z]+\.[0-9]$/);
  assert.match(h.ui.at(-1).message, new RegExp(`${job.name.replaceAll('.', '\\.')}.*${job.id}`));
  await h.command('wrk', 'jobs');
  assert.match(h.ui.at(-1).message, new RegExp(`${job.name.replaceAll('.', '\\.')}.*${job.id}`));
  await h.command('wrk', `status ${job.name}`);
  assert.match(h.ui.at(-1).message, /queued/);
  store.appendJobOutput(dir, job.id, 'work in progress');
  await h.command('wrk', `output ${job.name}`);
  assert.equal(h.ui.at(-1).message, 'work in progress');
  await h.command('wrk', `cancel ${job.name}`);
  assert.equal(store.isCancelRequested(dir, job.id), true);
  store.updateJob(dir, job.id, { status: 'succeeded' });
  await h.command('wrk', `status ${job.name}`);
  assert.match(h.ui.at(-1).message, /no active job/i);
  await h.command('wrk', `status ${job.id}`);
  assert.match(h.ui.at(-1).message, /succeeded/);
});

test('label cancellation rejects a job completed after resolution', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-race-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = store.storePath(root);
  const job = store.admitJob(dir, { name: 'act.rock.2', ownerId: 'owner-1', projectRoot: root, cwd: root, request: { runner: 'agent', prompt: 'race', lifetime: 'session' } });
  const h = harness({ realStore: dir });
  await h.event('session_start');
  // Completion occurs after name resolution but before the cancellation claim.
  // Direct store check is the race boundary: it must reject even with a previously resolved UUID.
  const resolved = store.resolveJobId(dir, job.name);
  store.updateJob(dir, job.id, { status: 'succeeded' });
  assert.throws(() => store.requestCancel(dir, resolved, job.name), /no active job/i);
  assert.equal(store.isCancelRequested(dir, job.id), false);
});

test('addressed file is not locally admitted; recipient admits on next turn and ACK confirms delivery', async t => {
  const previous = process.env.PI_INTERCOM_SESSION_ID;
  t.after(() => { if (previous === undefined) delete process.env.PI_INTERCOM_SESSION_ID; else process.env.PI_INTERCOM_SESSION_ID = previous; });
  const item = { key: 'comment', source: 'file', location: 'src/a.ts:1', text: 'check', recipient: 'BEACON', author: 'spoof', claimedBy: 'spoof' };
  let senderRegistration, receiverRegistration;
  const emitted = [], acknowledgements = [];
  const channel = (id) => ({ snapshot: () => ({ connected: true, supported: true }), listSessions: async () => [{ id: 'sender', name: 'writer' }, { id: 'receiver', name: 'BEACON' }], publish: (payload, options) => { assert.equal(options.audience, 'capable'); (id === 'sender' ? emitted : acknowledgements).push(payload); } });
  process.env.PI_INTERCOM_SESSION_ID = 'sender';
  const sender = harness({ collectFileMessages: async () => [item], peerRegister: registration => { senderRegistration = registration; registration.onReady(channel('sender')); } });
  await sender.event('session_start');
  await sender.event('before_agent_start', { prompt: 'send' });
  assert.equal(sender.jobs.size, 0);
  assert.equal(sender.branch.filter(e => e.customType === 'wrk-at7-peer-outbox').at(-1).data.state, 'pending');
  assert.equal(emitted.length, 1);
  process.env.PI_INTERCOM_SESSION_ID = 'receiver';
  const recipient = harness({ peerRegister: registration => { receiverRegistration = registration; registration.onReady(channel('receiver')); } });
  await recipient.event('session_start');
  receiverRegistration.onEvent({ type: 'message', fromSessionId: 'sender', payload: emitted[0] });
  assert.equal(recipient.jobs.size, 0);
  assert.equal(recipient.branch.filter(e => e.customType === 'wrk-at7-peer-inbox').at(-1).data.state, 'queued');
  // Reload before admission: the durable inbox must still be admitted exactly once.
  await recipient.event('session_start');
  await recipient.event('before_agent_start', { prompt: 'receive' });
  assert.equal(recipient.jobs.size, 1);
  assert.match([...recipient.jobs.values()][0].request.prompt, /Peer source.*untrusted context/);
  assert.equal([...recipient.jobs.values()][0].projectRoot, '/triage');
  await recipient.event('before_agent_start', { prompt: 'repeat' });
  receiverRegistration.onEvent({ type: 'message', fromSessionId: 'sender', payload: emitted[0] });
  assert.equal(recipient.jobs.size, 1);
  assert.ok(acknowledgements.length >= 1);
  process.env.PI_INTERCOM_SESSION_ID = 'sender';
  senderRegistration.onEvent({ type: 'message', fromSessionId: 'intruder', payload: acknowledgements[0] });
  assert.equal(sender.branch.filter(e => e.customType === 'wrk-at7-peer-outbox').at(-1).data.state, 'pending');
  senderRegistration.onEvent({ type: 'message', fromSessionId: 'receiver', payload: acknowledgements[0] });
  assert.equal(sender.branch.filter(e => e.customType === 'wrk-at7-peer-outbox').at(-1).data.state, 'delivered');
  await sender.event('session_start');
  await sender.event('before_agent_start', { prompt: 'again' });
  assert.equal(emitted.length, 1);
});

test('offline addressed comments stay pending and warn once, while plain and terminal intake works', async t => {
  const previous = process.env.PI_INTERCOM_SESSION_ID;
  process.env.PI_INTERCOM_SESSION_ID = 'sender';
  t.after(() => { if (previous === undefined) delete process.env.PI_INTERCOM_SESSION_ID; else process.env.PI_INTERCOM_SESSION_ID = previous; });
  const addressed = { key: 'remote', source: 'file', location: 'a.ts:1', text: 'remote', recipient: 'BEACON' };
  const plain = { key: 'local', source: 'file', location: 'a.ts:2', text: 'local' };
  const h = harness({ collectFileMessages: async () => [addressed, plain] });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'one' });
  await h.event('before_agent_start', { prompt: 'two' });
  assert.equal(h.jobs.size, 1);
  assert.equal(h.ui.filter(entry => /peer delivery pending/.test(entry.message ?? '')).length, 1);
  assert.equal(h.branch.filter(e => e.customType === 'wrk-at7-peer-outbox').at(-1).data.state, 'pending');
});

test('pending addressed comment retries after reload even when no longer in changed files', async t => {
  const previous = process.env.PI_INTERCOM_SESSION_ID;
  process.env.PI_INTERCOM_SESSION_ID = 'sender';
  t.after(() => { if (previous === undefined) delete process.env.PI_INTERCOM_SESSION_ID; else process.env.PI_INTERCOM_SESSION_ID = previous; });
  let registration, scans = 0;
  const sent = [];
  const h = harness({ collectFileMessages: async () => ++scans === 1 ? [{ key: 'committed', source: 'file', location: 'a.ts:1', text: 'check', recipient: 'BEACON' }] : [], peerRegister: value => { registration = value; value.onReady({ snapshot: () => ({ connected: true, supported: true }), listSessions: async () => [{ id: 'sender', name: 'writer' }, { id: 'receiver', name: 'BEACON' }], publish: payload => sent.push(payload) }); } });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'first' });
  assert.equal(sent.length, 1);
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'second' });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].key, sent[0].key);
  assert.equal(h.jobs.size, 0);
  registration.onEvent({ type: 'message', fromSessionId: 'receiver', payload: { kind: 'ack', key: sent[0].key, target: 'sender' } });
  assert.equal(h.branch.filter(e => e.customType === 'wrk-at7-peer-outbox').at(-1).data.state, 'delivered');
});

test('pinned peer survives name reuse and reload; only original session can ACK', async t => {
  const previous = process.env.PI_INTERCOM_SESSION_ID;
  process.env.PI_INTERCOM_SESSION_ID = 'sender';
  t.after(() => { if (previous === undefined) delete process.env.PI_INTERCOM_SESSION_ID; else process.env.PI_INTERCOM_SESSION_ID = previous; });
  const item = { key: 'pinned-comment', source: 'file', location: 'a.ts:1', text: 'check', recipient: 'BEACON' };
  let peers = [{ id: 'sender', name: 'writer' }, { id: 'original', name: 'BEACON' }], registration, scans = 0;
  const sent = [];
  const h = harness({ collectFileMessages: async () => ++scans === 1 ? [item] : [], peerRegister: value => { registration = value; value.onReady({ snapshot: () => ({ connected: true, supported: true }), listSessions: async () => peers, publish: signal => sent.push(signal) }); } });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'first' });
  assert.equal(sent[0].target, 'original');
  assert.equal(h.branch.filter(e => e.customType === 'wrk-at7-peer-outbox').at(-1).data.target, 'original');
  peers = [{ id: 'sender', name: 'writer' }, { id: 'replacement', name: 'BEACON' }];
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'after reload' });
  assert.equal(sent.length, 1, 'do not reroute old comment to the new name holder');
  registration.onEvent({ type: 'message', fromSessionId: 'replacement', payload: { kind: 'ack', key: sent[0].key, target: 'sender' } });
  assert.equal(h.branch.filter(e => e.customType === 'wrk-at7-peer-outbox').at(-1).data.state, 'pending');
  peers = [...peers, { id: 'original', name: 'different-name' }];
  await h.event('before_agent_start', { prompt: 'original returns' });
  assert.equal(sent.at(-1).target, 'original');
  registration.onEvent({ type: 'message', fromSessionId: 'original', payload: { kind: 'ack', key: sent[0].key, target: 'sender' } });
  assert.equal(h.branch.filter(e => e.customType === 'wrk-at7-peer-outbox').at(-1).data.state, 'delivered');
});

test('backlog of addressed comments lists live sessions once per owner turn', async t => {
  const previous = process.env.PI_INTERCOM_SESSION_ID;
  process.env.PI_INTERCOM_SESSION_ID = 'sender';
  t.after(() => { if (previous === undefined) delete process.env.PI_INTERCOM_SESSION_ID; else process.env.PI_INTERCOM_SESSION_ID = previous; });
  let lists = 0;
  const sent = [];
  const items = Array.from({ length: 4 }, (_, i) => ({ key: `batch-${i}`, source: 'file', location: `a.ts:${i + 1}`, text: 'check', recipient: 'BEACON' }));
  const h = harness({ collectFileMessages: async () => items, peerRegister: value => value.onReady({ snapshot: () => ({ connected: true, supported: true }), listSessions: async () => { lists++; return [{ id: 'sender', name: 'writer' }, { id: 'original', name: 'BEACON' }]; }, publish: signal => sent.push(signal) }) });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'first' });
  assert.equal(sent.length, 4);
  assert.equal(lists, 1);
  await h.event('before_agent_start', { prompt: 'retry' });
  assert.equal(lists, 2);
  assert.equal(sent.length, 8);
});

test('local unaddressed author and claim remain labeled untrusted in triage prompt', async () => {
  const h = harness({ collectFileMessages: async () => [{ key: 'roles', source: 'file', location: 'a.ts:1', text: 'look here', author: 'impersonator', claimedBy: 'BEACON' }] });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'owner turn' });
  const prompt = [...h.jobs.values()][0].request.prompt;
  assert.match(prompt, /look here/);
  assert.match(prompt, /impersonator/);
  assert.match(prompt, /BEACON/);
  assert.match(prompt, /untrusted|lower-trust/i);
  assert.match(prompt, /not.*approval/i);
});

test('first resolved recipient remains pinned if publication fails before ACK', async t => {
  const previous = process.env.PI_INTERCOM_SESSION_ID;
  process.env.PI_INTERCOM_SESSION_ID = 'sender';
  t.after(() => { if (previous === undefined) delete process.env.PI_INTERCOM_SESSION_ID; else process.env.PI_INTERCOM_SESSION_ID = previous; });
  let peers = [{ id: 'sender', name: 'writer' }, { id: 'original', name: 'BEACON' }], sent = 0;
  const h = harness({ collectFileMessages: async () => [{ key: 'failed-first', source: 'file', location: 'a.ts:1', text: 'check', recipient: 'BEACON' }], peerRegister: value => value.onReady({ snapshot: () => ({ connected: true, supported: true }), listSessions: async () => peers, publish: () => { sent++; throw new Error('disconnected during publish'); } }) });
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'first' });
  assert.equal(h.branch.filter(e => e.customType === 'wrk-at7-peer-outbox').at(-1).data.target, 'original');
  peers = [{ id: 'sender', name: 'writer' }, { id: 'replacement', name: 'BEACON' }];
  await h.event('session_start');
  await h.event('before_agent_start', { prompt: 'name reused' });
  assert.equal(sent, 1, 'never attempt publication to a replacement name holder');
});
