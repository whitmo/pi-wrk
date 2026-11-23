import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  registerSession, closeSession, addresses, sendMarkdown,
  processMailbox, createPipeBroker, listSessions,
} from '../src/file-in.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'wrk-file-in-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('targeted Markdown stays in its named inbox and archives after delivery', t => {
  const root = setup(t);
  const a = registerSession(root, 'session-a', 'arc one');
  registerSession(root, 'session-b', 'arc two');
  sendMarkdown(root, a.handle, '# hello\n');
  const received = [];
  assert.deepEqual(processMailbox(root, 'session-b', text => received.push(text)), { delivered: 0, failed: 0 });
  assert.deepEqual(processMailbox(root, 'session-a', text => received.push(text)), { delivered: 1, failed: 0 });
  assert.deepEqual(received, ['# hello']);
  assert.equal(processMailbox(root, 'session-a', () => assert.fail('duplicate')).delivered, 0);
  assert.equal(existsSync(join(a.mailbox, 'processed')), true);
});

test('a session renamed after startup gets an obvious path without losing its mailbox', t => {
  const root = setup(t);
  const original = registerSession(root, 'session-a');
  const named = registerSession(root, 'session-a', 'arc cleanup');
  assert.equal(named.handle, original.handle);
  assert.match(named.mailbox, /arc-cleanup/);
  assert.notEqual(named.mailbox, original.mailbox);
  sendMarkdown(root, named.mailbox, 'to the named alias');
  const broker = createPipeBroker(root);
  broker.poll();
  const sent = spawnSync('sh', ['-c', 'printf %s "$1" > "$2"', 'sh', 'alias FIFO', named.fifo], { timeout: 2000 });
  assert.equal(sent.status, 0, String(sent.error));
  broker.poll(); broker.close();
  const received = [];
  processMailbox(root, 'session-a', text => received.push(text));
  assert.deepEqual(received.sort(), ['alias FIFO', 'to the named alias']);
});

test('general fans out to live handles once; reload retains named pending mail', t => {
  const root = setup(t);
  const a = registerSession(root, 'session-a', 'arc one');
  const b = registerSession(root, 'session-b', 'arc two');
  sendMarkdown(root, 'general', 'broadcast');
  closeSession(root, 'session-b');
  sendMarkdown(root, a.handle, 'during reload');
  assert.equal(registerSession(root, 'session-a', 'renamed arc').handle, a.handle);
  const messages = [];
  processMailbox(root, 'session-a', s => messages.push(s));
  assert.deepEqual(messages.sort(), ['broadcast', 'during reload']);
  const forB = [];
  processMailbox(root, 'session-b', s => forB.push(s));
  assert.deepEqual(forB, ['broadcast']);
  assert.equal(listSessions(root).filter(s => s.live).length, 1);
  assert.equal(b.handle !== a.handle, true);
  closeSession(root, 'session-a');
  assert.throws(() => sendMarkdown(root, 'general', 'not for future sessions'), /no live file-in recipients/);
});

test('failed delivery is archived rather than silently retried', t => {
  const root = setup(t);
  const a = registerSession(root, 'session-a', 'arc one');
  sendMarkdown(root, a.handle, 'fail');
  assert.equal(processMailbox(root, 'session-a', () => { throw Error('not ready'); }).failed, 1);
  assert.equal(processMailbox(root, 'session-a', () => assert.fail('retry')).delivered, 0);
  assert.equal(existsSync(join(a.mailbox, 'failed')), true);
});

test('per-session FIFO and general FIFO deliver without one session stealing another', async t => {
  const root = setup(t);
  const a = registerSession(root, 'session-a', 'arc one');
  registerSession(root, 'session-b', 'arc two');
  const broker = createPipeBroker(root);
  t.after(() => broker.close());
  broker.poll();
  for (const [path, expected] of [[a.fifo, 'targeted fifo'], [addresses(root).general.fifo, 'broadcast fifo']]) {
    const child = spawn('sh', ['-c', 'printf %s "$1" > "$2"', 'sh', expected, path]);
    const finished = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(Error('FIFO writer failed')));
    });
    await finished;
    for (let i = 0; i < 20; i++) broker.poll();
  }
  const one = [], two = [];
  processMailbox(root, 'session-a', s => one.push(s));
  processMailbox(root, 'session-b', s => two.push(s));
  assert.deepEqual(one, ['targeted fifo', 'broadcast fifo']);
  assert.deepEqual(two, ['broadcast fifo']);
});

test('original .agents/pi/file-in Markdown inbox waits for a quiet write, then broadcasts and archives', async t => {
  const root = setup(t);
  const store = join(root, '.agents', 'wrk');
  mkdirSync(store, { recursive: true });
  const a = registerSession(store, 'session-a', 'arc one');
  registerSession(store, 'session-b', 'arc two');
  assert.equal(a.mailbox.startsWith(join(root, '.agents', 'pi', 'file-in', 'handles')), true);
  const inbox = join(root, '.agents', 'pi', 'file-in');
  writeFileSync(join(inbox, 'old-handoff.md'), '# from CIPR');
  const broker = createPipeBroker(store);
  broker.poll();
  assert.equal(existsSync(join(inbox, 'old-handoff.md')), true, 'still-writing file must not be archived');
  await new Promise(resolve => setTimeout(resolve, 280));
  broker.poll();
  broker.close();
  for (const id of ['session-a', 'session-b']) {
    const received = [];
    processMailbox(store, id, text => received.push(text));
    assert.deepEqual(received, ['# from CIPR']);
  }
  assert.equal(existsSync(join(inbox, 'processed', 'old-handoff.md')), true);
});

test('send-to-pi helper accepts stdin and a queryable handle path', t => {
  const root = setup(t);
  const a = registerSession(root, 'session-a', 'arc one');
  const cli = new URL('../bin/send-to-pi.mjs', import.meta.url).pathname;
  const sent = spawnSync(process.execPath, [cli, '--store', root, a.mailbox], { input: '# from helper', encoding: 'utf8' });
  assert.equal(sent.status, 0, sent.stderr);
  const messages = [];
  processMailbox(root, 'session-a', text => messages.push(text));
  assert.deepEqual(messages, ['# from helper']);
  const viaPipeAddress = spawnSync(process.execPath, [cli, '--store', root, a.fifo], { input: '# pipe address', encoding: 'utf8' });
  assert.equal(viaPipeAddress.status, 0, viaPipeAddress.stderr);
  processMailbox(root, 'session-a', text => messages.push(text));
  assert.deepEqual(messages, ['# from helper', '# pipe address']);
  assert.throws(() => sendMarkdown(root, join(root, 'outside', 'mailbox'), '# escape'), /address outside file-in handles/);
  assert.equal(existsSync(join(root, 'outside')), false);
  const listed = spawnSync(process.execPath, [cli, '--store', root, '--list'], { encoding: 'utf8' });
  assert.match(listed.stdout, /arc one/);
  assert.match(listed.stdout, /session-a/);
});
