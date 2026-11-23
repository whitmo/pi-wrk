import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { storePath, listJobs } from '../src/store.mjs';
import { ensureWorker } from '../src/worker.mjs';
import { registerSession, addresses, processMailbox } from '../src/file-in.mjs';

test('disposable pi-wrk worker serves file-in pipes without admitting jobs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-file-in-worker-'));
  const dir = storePath(root);
  const a = registerSession(dir, 'session-a', 'arc one');
  registerSession(dir, 'session-b', 'arc two');
  let pid;
  t.after(async () => {
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      for (let i = 0; i < 50 && existsSync(join(dir, 'worker.lock')); i++)
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    rmSync(root, { recursive: true, force: true });
  });
  await ensureWorker(dir, { timeoutMs: 5000 });
  pid = YAML.parse(readFileSync(join(dir, 'worker.lock'), 'utf8')).pid;
  for (const [path, content] of [[a.fifo, 'private'], [addresses(dir).general.fifo, 'everyone']]) {
    const sent = spawnSync('sh', ['-c', 'printf %s "$1" > "$2"', 'sh', content, path], { encoding: 'utf8', timeout: 4000 });
    assert.equal(sent.status, 0, sent.stderr || String(sent.error));
  }
  const aReceived = [], bReceived = [];
  for (let i = 0; i < 80; i++) {
    processMailbox(dir, 'session-a', text => aReceived.push(text));
    processMailbox(dir, 'session-b', text => bReceived.push(text));
    if (aReceived.length === 2 && bReceived.length === 1) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(aReceived.sort(), ['everyone', 'private']);
  assert.deepEqual(bReceived, ['everyone']);
  assert.equal(listJobs(dir).length, 0);
});
