import { message, type At7Message } from './at7-files.ts';
import type { readTabScreen } from '../src/zellij-watch.mjs';

type Reader = typeof readTabScreen;

export function createTabRegistry(read: Reader, ownPaneId?: () => number | undefined) {
  const tabs = new Map<string, { created: boolean; snapshot?: string; tabId?: number }>();
  let session: string | undefined;
  let generation = 0;
  return {
    created(tabName: string) { tabs.set(tabName, { created: true }); },
    visited(tabName: string) { tabs.set(tabName, { created: false }); },
    async baseline(sessionName: string, tabName: string) {
      const tab = tabs.get(tabName);
      if (!tab || tab.created) return;
      const current = generation;
      const { tabId, snapshot } = await read(sessionName, { tabName, tabId: undefined, ownPaneId: ownPaneId?.() });
      if (generation !== current || tabs.get(tabName) !== tab) return;
      session = sessionName;
      tab.tabId = tabId;
      tab.snapshot = snapshot;
    },
    clear() { tabs.clear(); session = undefined; generation++; },
    async scan(sessionName: string, seen: ReadonlySet<string>): Promise<At7Message[]> {
      if (session && session !== sessionName) { tabs.clear(); generation++; }
      session = sessionName;
      const current = generation;
      const result: At7Message[] = [];
      for (const [name, tab] of tabs) {
        const { tabId, snapshot } = await read(sessionName, { tabName: tab.tabId === undefined ? name : undefined, tabId: tab.tabId, ownPaneId: ownPaneId?.() });
        if (generation !== current || session !== sessionName) return [];
        const lines = (screen: string) => screen.replace(/\n$/, '').split('\n');
        const before = tab.snapshot === undefined ? [] : lines(tab.snapshot);
        const after = lines(snapshot);
        // Reuse the longest retained screen overlap, including changed lines at the same position.
        let overlap = 0;
        for (let n = Math.min(before.length, after.length); n > 0; n--) {
          if (before.slice(-n).every((line, i) => line === after[i])) { overlap = n; break; }
        }
        const fresh = tab.snapshot === undefined ? (tab.created ? after : []) : after.slice(overlap);
        for (const line of fresh) {
          const item = message('zellij', `${sessionName}/${name}`, line);
          if (item && !seen.has(item.key)) result.push(item);
        }
        tab.snapshot = snapshot;
        tab.tabId = tabId;
      }
      return result;
    },
  };
}
