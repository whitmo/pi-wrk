import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const { createTabRegistry } = await createJiti(import.meta.url).import('../extensions/at7-tabs.ts');

test('created tabs deliver first visible messages; visited tabs baseline and only deliver later lines', async () => {
  const screens = new Map([['new', '  @@7 first\necho "@@7 shell input"\n$ @@7 shell history'], ['visited', '# @@7 old']]);
  const reads = [];
  const tabs = createTabRegistry(async (session, selector) => { const name = selector.tabName ?? (selector.tabId === 1 ? 'new' : 'visited'); reads.push(name); return { tabId: name === 'new' ? 1 : 2, snapshot: screens.get(name) }; });
  tabs.created('new');
  tabs.visited('visited');
  const first = await tabs.scan('my-session', new Set());
  assert.deepEqual(first.map(item => item.text), ['first']);
  screens.set('visited', '# @@7 old\n-- @@7 later');
  screens.set('new', '  @@7 first\necho "@@7 shell input"\n$ @@7 shell history');
  const next = await tabs.scan('my-session', new Set(first.map(item => item.key)));
  assert.deepEqual(next.map(item => item.text), ['later']);
  assert.deepEqual(await tabs.scan('my-session', new Set([...first, ...next].map(item => item.key))), []);
  assert.equal(reads.includes('unrelated user-selected tab'), false);
});

test('a newly visited tab baselines before the first scan', async () => {
  let snapshot = '@@7 existing';
  const tabs = createTabRegistry(async () => ({ tabId: 7, snapshot }));
  tabs.visited('existing');
  assert.deepEqual(await tabs.scan('s', new Set()), []);
  snapshot += '\n@@7 new line';
  assert.deepEqual((await tabs.scan('s', new Set())).map(item => item.text), ['new line']);
  tabs.clear();
  assert.deepEqual(await tabs.scan('s', new Set()), []);
});
