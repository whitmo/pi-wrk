import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { getJob, recordVerdict, writeNotice } from '../src/store.mjs';

/** Loaded explicitly only in worker-owned Pi agents, never in the main session. */
export function registerRunnerMessages(pi: Pick<ExtensionAPI, 'registerTool'>, environment: NodeJS.ProcessEnv = process.env): void {
  const storeDir = environment.PI_WRK_STORE;
  const jobId = environment.PI_WRK_JOB_ID;
  if (!storeDir || !jobId) throw new Error('Message tool requires worker identity');
  pi.registerTool({
    name: 'wrk_message',
    label: 'Message submitting session',
    description: 'Store a concise message for the submitting session. Optionally report the task semantic verdict explicitly (success or failure), once per job. A message does not imply a reply.',
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 2000 }),
      verdict: Type.Optional(Type.Union([Type.Literal('success'), Type.Literal('failure')])),
      kind: Type.Optional(Type.Union([
        Type.Literal('question'), Type.Literal('blocker'), Type.Literal('guidance'), Type.Literal('result'), Type.Literal('info'),
      ])),
    }),
    async execute(_callId, { message, kind = 'info', verdict }) {
      const job = getJob(storeDir, jobId);
      if (verdict !== undefined) recordVerdict(storeDir, jobId, verdict);
      writeNotice(storeDir, { ownerId: job.ownerId, jobId: job.id, message, kind });
      return {
        content: [{ type: 'text', text: 'Notice stored; delivery does not imply a reply.' }],
        details: { jobId: job.id },
      };
    },
  });
}

export default registerRunnerMessages;
