import test from 'node:test';
import assert from 'node:assert/strict';
import { readTab } from '../src/zellij-watch.mjs';

function fixture(panes, screens = {}) {
  const calls = [];
  const run = async (binary, args) => {
    calls.push([binary, ...args]);
    if (args.includes('list-panes')) return { stdout: JSON.stringify(panes) };
    const pane = args[args.indexOf('--pane-id') + 1];
    return { stdout: screens[pane] ?? '' };
  };
  return { run, calls };
}

const panes = [
  { id: 3, tab_id: 7, tab_name: 'term', is_plugin: false },
  { id: 2, tab_id: 7, tab_name: 'term', is_plugin: true },
  { id: 9, tab_id: 8, tab_name: 'other', is_plugin: false },
];

test('reads named tab without changing focus and detects later screen changes', async () => {
  const f = fixture(panes, { terminal_3: 'first screen', terminal_9: 'not watched' });
  const first = await readTab('agent-session', { tabName: 'term' }, f.run);
  const same = await readTab('agent-session', { tabId: first.tabId }, f.run);
  assert.equal(first.tabId, 7);
  assert.equal(first.snapshot, same.snapshot);
  assert.deepEqual(f.calls[0], ['zellij', '--session', 'agent-session', 'action', 'list-panes', '--json', '--tab']);
  assert.deepEqual(f.calls[1], ['zellij', '--session', 'agent-session', 'action', 'dump-screen', '--pane-id', 'terminal_3']);
  assert.equal(f.calls.some(call => call.includes('focus-pane-id') || call.includes('go-to-tab-name')), false);
  f.run = fixture(panes, { terminal_3: 'new output' }).run;
  assert.notEqual((await readTab('agent-session', { tabId: first.tabId }, f.run)).snapshot, first.snapshot);
});

test('rejects missing, ambiguous, or empty terminal tabs and missing session', async () => {
  await assert.rejects(readTab('', { tabName: 'term' }, fixture(panes).run), /zellij session/i);
  await assert.rejects(readTab('agent', { tabName: 'unknown' }, fixture(panes).run), /tab.*not found/i);
  await assert.rejects(readTab('agent', { tabName: 'term' }, fixture([...panes, { id: 5, tab_id: 10, tab_name: 'term', is_plugin: false }]).run), /multiple tabs/i);
  await assert.rejects(readTab('agent', { tabName: 'term' }, fixture([{ id: 2, tab_id: 7, tab_name: 'term', is_plugin: true }]).run), /terminal pane/i);
  await assert.rejects(readTab('agent', { tabName: 'term', ownPaneId: 3 }, fixture(panes).run), /own Pi pane/i);
  await assert.rejects(readTab('agent', { tabId: 7 }, fixture([]).run), /tab.*not found/i);
});
