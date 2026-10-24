#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { runWorker } from '../src/worker.mjs';
import { storePath, listJobs, getJob, readJobOutput, requestCancel } from '../src/store.mjs';

async function main(args) {
  const command = args.shift() ?? 'jobs';
  const index = args.indexOf('--store');
  let storeDir = storePath(process.cwd());
  if (index !== -1) {
    if (!args[index + 1]) throw new Error('--store requires a path');
    storeDir = args[index + 1];
    args.splice(index, 2);
  }
  if (!isAbsolute(storeDir)) throw new Error('store must be absolute');
  storeDir = resolve(storeDir);
  if (command === 'worker') {
    if (args.length) throw new Error('usage: worker --store <absolute path>');
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    await runWorker({ storeDir, signal: controller.signal });
    return;
  }
  if (command === 'jobs') {
    if (args.length) throw new Error('usage: jobs [--store <path>]');
    for (const job of listJobs(storeDir)) console.log(`${job.id} ${job.status} ${job.request.runner} ${job.request.lifetime} ${job.summary ?? job.error ?? ''}`);
    return;
  }
  if (!['status', 'output', 'cancel'].includes(command) || args.length !== 1) throw new Error('usage: jobs|status <id>|output <id>|cancel <id> [--store <path>]');
  const job = getJob(storeDir, args[0]);
  if (command === 'status') console.log(JSON.stringify(job, null, 2));
  if (command === 'output') process.stdout.write(readJobOutput(storeDir, job.id));
  if (command === 'cancel') { requestCancel(storeDir, job.id); console.log(`${job.id}: cancellation requested`); }
}

main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
