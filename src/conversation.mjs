import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @typedef {{role: 'user' | 'assistant', text: string}} ConversationTurn */

/** @returns {ConversationTurn[]} */
export function captureConversation(sessionManager) {
  if (typeof sessionManager.buildSessionProjection !== 'function') {
    throw new Error('Background context requires Pi session projection support');
  }
  const turns = [];
  let bytes = 0;
  function append(role, text) {
    if (!text.trim()) return;
    const turn = { role, text };
    bytes += Buffer.byteLength(JSON.stringify(turn)) + 1;
    if (bytes > 256 * 1024) throw new Error('Background context exceeds 256 KiB; compact the conversation or use /wrk bg without +');
    turns.push(turn);
  }
  for (const { sourceEntry, messages } of sessionManager.buildSessionProjection().entries) {
    if (sourceEntry.type === 'compaction') {
      for (const message of messages) {
        if (message.role === 'compactionSummary' && typeof message.summary === 'string') {
          append('user', '[Summary of the parent conversation]\n' + message.summary);
        }
      }
      continue;
    }
    if (sourceEntry.type !== 'message') continue;
    for (const { role, content } of messages) {
      if (role !== 'user' && role !== 'assistant') continue;
      const text = typeof content === 'string' ? content : (content ?? [])
        .filter(block => block.type === 'text').map(block => block.text).join('\n');
      append(role, text);
    }
  }
  return turns;
}

export async function withConversationSession(conversation, cwd, run) {
  if (!conversation?.length) return run(['--no-session']);
  const dir = mkdtempSync(join(tmpdir(), 'pi-wrk-conversation-'));
  try {
    const timestamp = new Date();
    const entries = [{ type: 'session', version: 3, id: randomUUID(), timestamp, cwd }];
    let parentId = null;
    for (const { role, text } of conversation) {
      const id = randomUUID();
      const message = role === 'user' ? { role, content: text } : {
        role: 'assistant', content: [{ type: 'text', text }],
        api: 'openai-completions', provider: 'pi-wrk', model: 'parent-conversation',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
      };
      entries.push({ type: 'message', id, parentId, timestamp, message: { ...message, timestamp: timestamp.valueOf() } });
      parentId = id;
    }
    const path = join(dir, 'conversation.jsonl');
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
    return await run(['--session', path]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
