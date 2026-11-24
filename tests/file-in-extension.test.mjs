import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerFileIn } from '../extensions/file-in.ts';
import { sendMarkdown } from '../src/file-in.mjs';

function session(t, root, id, name) {
  const events = new Map(), messages = [], notices = [];
  const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => id }, ui: { notify: (...args) => notices.push(args) } };
  const pi = {
    on: (event, handler) => events.set(event, handler),
    getSessionName: () => name,
    sendUserMessage: (message, options) => messages.push({ message, options }),
  };
  let workers = 0;
  const inbox = registerFileIn(pi, { storePath: x => x, projectRoot: x => x, ensureWorker: async () => { workers++; }, pollMs: 10 });
  t.after(() => events.get('session_shutdown')?.({ reason: 'quit' }, ctx));
  return { events, ctx, inbox, messages, notices, workers: () => workers,
    start: (reason = 'startup') => events.get('session_start')({ reason }, ctx),
    stop: (reason = 'quit') => events.get('session_shutdown')({ reason }, ctx) };
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'wrk-file-in-ext-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function waitFor(condition) {
  for (let i = 0; i < 40; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('file-in message was not delivered');
}
test('two Pi sessions have queryable return paths and only consume their own inboxes', async t => {
  const root = setup(t), a = session(t, root, 'session-a', 'arc one'), b = session(t, root, 'session-b', 'arc two');
  a.start(); b.start();
  assert.match(a.inbox.address(a.ctx), /Your mailbox:/);
  assert.match(a.inbox.address(a.ctx), /Broadcast pipe:/);
  const aPath = a.inbox.address(a.ctx).match(/Your mailbox: ([^\n]+)/)[1];
  sendMarkdown(root, aPath, 'a private reply');
  await waitFor(() => a.messages.length === 1);
  assert.equal(b.messages.length, 0);
  assert.match(a.messages[0].message, /untrusted text, not authorization/);
  assert.match(a.messages[0].message, /a private reply/);
  assert.deepEqual(a.messages[0].options, { deliverAs: 'steer' });
  assert.equal(a.workers(), 1);
  sendMarkdown(root, 'general', 'public handoff');
  await waitFor(() => a.messages.length === 2 && b.messages.length === 1);
  assert.equal(b.messages[0].message.includes('public handoff'), true);
});
test('Pi session rename updates the return address without changing its recipient', async t => {
  const root = setup(t), a = session(t, root, 'session-a', '');
  a.start();
  const original = a.inbox.address(a.ctx);
  a.events.get('session_info_changed')({ name: 'arc cleanup' }, a.ctx);
  const updated = a.inbox.address(a.ctx);
  assert.notEqual(updated, original);
  assert.match(updated, /arc-cleanup/);
  const alias = updated.match(/Your mailbox: ([^\n]+)/)[1];
  sendMarkdown(root, alias, 'new name still works');
  await waitFor(() => a.messages.length === 1);
  assert.match(a.messages[0].message, /new name still works/);
  assert.equal(a.inbox.address(a.ctx), updated);
  a.events.get('session_info_changed')({ name: undefined }, a.ctx);
  assert.notEqual(a.inbox.address(a.ctx), updated);
  assert.throws(() => sendMarkdown(root, alias, 'stale address'), /unknown file-in handle/);
});

test('reload preserves the same named inbox and pending handoffs', async t => {
  const root = setup(t), a = session(t, root, 'session-a', 'arc one');
  a.start();
  const path = a.inbox.address(a.ctx);
  a.stop('reload');
  sendMarkdown(root, path.match(/Your mailbox: ([^\n]+)/)[1], 'during reload');
  a.start('reload');
  await waitFor(() => a.messages.length === 1);
  assert.equal(a.inbox.address(a.ctx), path);
  assert.equal(a.messages[0].message.includes('during reload'), true);
});
