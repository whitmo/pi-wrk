import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export type At7Message = { key: string; source: 'file' | 'zellij'; location: string; text: string; recipient?: string; claimedBy?: string; author?: string }; 
const exec = promisify(execFile);
const marker = /^\s*(?:#|\/\/|--|\/\*|\*|<!--)\s*@@7(?:\s+)(.+?)\s*(?:\*\/|-->)?\s*$/;

export function message(source: At7Message['source'], location: string, line: string): At7Message | undefined {
  const text = (source === 'zellij' ? /^\s*@@7\s+(.+?)\s*$/.exec(line)?.[1] : undefined) ?? marker.exec(line)?.[1]?.trim();
  if (!text) return undefined;
  const item: At7Message = { source, location, text, key: JSON.stringify([source, location, text]) };
  if (source === 'file') {
    let rest = text;
    while (rest.startsWith('@@7:')) {
      const tag = /^@@7:([@+:])([^\s]+)(?:\s+|$)/.exec(rest);
      if (!tag || !/^[\w.#-]+$/.test(tag[2])) return undefined;
      const field = tag[1] === '@' ? 'recipient' : tag[1] === '+' ? 'author' : 'claimedBy';
      if (item[field]) return undefined;
      item[field] = tag[2];
      rest = rest.slice(tag[0].length);
    }
    if (!rest.trim()) return undefined;
    if (rest !== text) item.text = rest.trim();
  }
  return item;
}

export async function collectFileMessages(root: string, scope: 'changed' | 'all', seen: ReadonlySet<string>): Promise<At7Message[]> {
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })).stdout as Buffer;
  const tracked = new Set((await git('ls-files', '-z', '--cached')).toString().split('\0').filter(Boolean));
  const paths = (await git('ls-files', '-z', '--cached', '--others', '--exclude-standard')).toString().split('\0').filter(Boolean);
  const found: At7Message[] = [];
  for (const path of paths) {
    try {
      if (!(await lstat(join(root, path))).isFile()) continue;
      const bytes = await readFile(join(root, path));
      if (bytes.includes(0)) continue;
      const lines = bytes.toString('utf8').split('\n');
      let eligible: Set<number> | undefined;
      if (scope === 'changed' && tracked.has(path)) {
        eligible = new Set();
        const diff = (await git('diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--unified=0', '--', path)).toString();
        let line = 0;
        for (const part of diff.split('\n')) {
          const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(part);
          if (hunk) line = Number(hunk[1]);
          else if (part.startsWith('+') && !part.startsWith('+++')) eligible.add(line++);
          else if (part.startsWith(' ') && line) line++;
        }
      }
      for (let i = 0; i < lines.length; i++) {
        if (eligible && !eligible.has(i + 1)) continue;
        const item = message('file', `${path}:${i + 1}`, lines[i]);
        if (item && !seen.has(item.key)) found.push(item);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EACCES') continue;
      throw error;
    }
  }
  return found;
}
