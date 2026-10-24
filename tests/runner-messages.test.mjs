import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { admitJob, readNotices, storePath } from '../src/store.mjs';

const { registerRunnerMessages } = await createJiti(import.meta.url).import('../extensions/runner-messages.ts');

test('agent message tool stores a question for the job owner without implying a reply', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wrk-msg-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = storePath(root);
  const job = admitJob(dir, { ownerId: 'absent-owner', projectRoot: root, cwd: root,
    request: { runner: 'agent', prompt: 'inspect', options: {}, lifetime: 'independent', queue: null } });
  let tool;
  registerRunnerMessages({ registerTool: value => { tool = value; } }, { PI_WRK_STORE: dir, PI_WRK_JOB_ID: job.id });
  const result = await tool.execute('call-1', { message: 'Which config should I use?', kind: 'question' });
  assert.match(result.content[0].text, /does not imply a reply/i);
  const [notice] = readNotices(dir, 'absent-owner');
  assert.equal(notice.kind, 'question');
  assert.equal(notice.message, 'Which config should I use?');
  assert.equal(notice.jobId, job.id);
  assert.equal(readNotices(dir, 'absent-owner').length, 1);
  assert.equal(readNotices(dir, 'different-owner').length, 0);
});

test('agent message tool fails closed without worker identity', () => {
  assert.throws(() => registerRunnerMessages({ registerTool() {} }, {}), /worker identity/i);
});
