import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { getJob, writeNotice } from '../src/store.mjs';

/** Loaded explicitly only in worker-owned Pi agents, never in the main session. */
export function registerRunnerMessages(pi: Pick<ExtensionAPI, 'registerTool'>, environment: NodeJS.ProcessEnv = process.env): void {
  const storeDir = environment.PI_WRK_STORE;
  const jobId = environment.PI_WRK_JOB_ID;
  if (!storeDir || !jobId) throw new Error('Message tool requires worker identity');
  pi.registerTool({
    name: 'wrk_message',
    label: 'Message submitting session',
    description: 'Store a concise question, blocker, guidance or result for the submitting session. Delivery does not imply a reply; do not wait indefinitely for one.',
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 2000 }),
      kind: Type.Optional(Type.Union([
        Type.Literal('question'), Type.Literal('blocker'), Type.Literal('guidance'), Type.Literal('result'), Type.Literal('info'),
      ])),
    }),
    async execute(_callId, { message, kind = 'info' }) {
      const job = getJob(storeDir, jobId);
      writeNotice(storeDir, { ownerId: job.ownerId, jobId: job.id, message, kind });
      return {
        content: [{ type: 'text', text: 'Notice stored; delivery does not imply a reply.' }],
        details: { jobId: job.id },
      };
    },
  });
}

export default registerRunnerMessages;
