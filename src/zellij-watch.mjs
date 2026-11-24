import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Read one tab without focusing it; a screen snapshot is not a raw output stream. */
export async function readTab(sessionName, selection, run = execute) {
  return captureTab(sessionName, selection, run, false);
}

/** Read visible terminal text for @@7 intake without changing the watch snapshot contract. */
export async function readTabScreen(sessionName, selection, run = execute) {
  return captureTab(sessionName, selection, run, true);
}

async function captureTab(sessionName, { tabName, tabId, ownPaneId }, run, raw) {
  if (!sessionName) throw new Error('Zellij session unavailable (ZELLIJ_SESSION_NAME is not set)');
  const action = async (args) => {
    const { stdout } = await run('zellij', ['--session', sessionName, 'action', ...args], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
    return stdout;
  };
  const panes = JSON.parse(await action(['list-panes', '--json', '--tab']));
  if (!Array.isArray(panes)) throw new Error('Zellij returned an invalid pane list');
  const matches = panes.filter(pane => tabId === undefined ? pane.tab_name === tabName : pane.tab_id === tabId);
  if (!matches.length) throw new Error(`Zellij tab ${tabName ?? tabId} not found`);
  if (tabId === undefined && new Set(matches.map(pane => pane.tab_id)).size !== 1)
    throw new Error(`Multiple tabs named ${tabName}; use a unique tab name`);
  const id = matches[0].tab_id;
  const terminals = matches.filter(pane => !pane.is_plugin).sort((a, b) => a.id - b.id);
  if (!terminals.length) throw new Error(`Zellij tab ${tabName ?? tabId} has no terminal pane`);
  if (terminals.some(pane => pane.id === ownPaneId))
    throw new Error(`Cannot watch the tab containing this agent's own Pi pane (${ownPaneId})`);
  const snapshots = [];
  for (const pane of terminals) {
    const screen = await action(['dump-screen', '--pane-id', `terminal_${pane.id}`]);
    snapshots.push([pane.id, raw ? screen : createHash('sha256').update(screen).digest('hex')]);
  }
  return { tabId: id, snapshot: raw ? snapshots.map(([, screen]) => screen).join('\n') : JSON.stringify(snapshots) };
}
