import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFocus } from '../src/focus.mjs';
import { entry } from './fixtures/focus.mjs';
import { prepareFocusActivation, registerInheritedFocus } from '../src/focus-runtime.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wrk-focus-extension-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'index.mjs');
  // Compatible extension fixture exercises registration and lifecycle, not a model.
  writeFileSync(join(dir, 'focus-session.mjs'), `export function createLocalFocusBinding(input) { return { version: 1, source: 'local', ...input }; }`);
  writeFileSync(path, `export default function(pi) {
    pi.on('session_start', (event, ctx) => {
      const active = event.reason === 'resume' ? ctx.sessionManager.getBranch().at(-1).data.active : null;
      pi.on('before_agent_start', () => ({ systemPrompt: JSON.stringify({ active, cwd: ctx.cwd }) }));
    });
  }`);
  return { path, focus: captureFocus([entry()], '/source', '/source/src', 'active', path) };
}

test('activation requires compatible installed extension and binding API', async t => {
  const { path, focus } = fixture(t);
  await prepareFocusActivation(focus);
  const invalid = `${path}.invalid.mjs`;
  writeFileSync(invalid, 'export default 42;');
  await assert.rejects(prepareFocusActivation({ ...focus, extensionPath: invalid }), /compatible|factory/i);
  await assert.rejects(prepareFocusActivation({ ...focus, extensionPath: '/missing/index.ts' }), /unavailable/i);
});

test('active adapter restores captured binding before focus startup and uses source cwd', async t => {
  const { focus } = fixture(t);
  const handlers = new Map(), branch = [];
  const pi = {
    on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
    appendEntry(customType, data) { branch.push({ type: 'custom', customType, data }); },
  };
  const ctx = { cwd: '/isolated/worktree', sessionManager: { getSessionId: () => 'child-session', getBranch: () => branch } };
  await registerInheritedFocus(pi, focus);
  for (const handler of handlers.get('session_start')) await handler({ reason: 'new' }, ctx);
  const result = await handlers.get('before_agent_start')[0]({ systemPrompt: '' }, ctx);
  assert.equal(branch[0].data.agentSessionId, 'child-session');
  assert.deepEqual(branch[0].data.active, focus.active);
  assert.deepEqual(JSON.parse(result.systemPrompt), { active: focus.active, cwd: '/source/src' });
  assert.equal(ctx.cwd, '/isolated/worktree');
});
