#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addresses, listSessions, sendMarkdown } from '../src/file-in.mjs';

const args = process.argv.slice(2);
let storeDir;
const index = args.indexOf('--store');
if (index !== -1) {
  storeDir = args[index + 1];
  args.splice(index, 2);
}
if (!storeDir) {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (git.status !== 0) throw Error('run in a Git checkout or pass --store <absolute path>');
  storeDir = join(git.stdout.trim(), '.agents', 'wrk');
}
if (args[0] === '--list') {
  for (const item of listSessions(storeDir))
    console.log(`${item.name} (${item.sessionId}) ${addresses(storeDir, item.alias ?? item.handle).mailbox} [${item.live ? 'live' : 'offline'}]`);
  console.log(`general ${addresses(storeDir).general.mailbox} (broadcast to live sessions)`);
} else {
  const to = args.shift();
  if (!to) throw Error('usage: send-to-pi [--store <path>] <handle|mailbox> [message]; or --list');
  const content = args.length ? args.join(' ') : readFileSync(0, 'utf8');
  for (const file of sendMarkdown(storeDir, to, content)) console.log(file);
}
