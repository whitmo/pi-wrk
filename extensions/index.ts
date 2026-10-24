import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type Request = {
  runner: string;
  prompt: string;
  options: Record<string, unknown>;
  queue: string | null;
  lifetime: 'session' | 'independent';
  handoff: boolean;
};
type Snapshot = { entryId: string; prompt: string; sessionId: string };
type Job = {
  id: string;
  status: string;
  request: Request;
  ownerId: string;
  handoff?: { ready: boolean; snapshot: Snapshot; reason?: string };
  error?: string;
};
type Session = {
  getSessionId(): string;
  getBranch(): Array<{ id: string; type: string; message?: { role?: string; content?: unknown } }>;
};
type Context = {
  cwd: string;
  ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void; setStatus(key: string, value: string | undefined): void };
  sessionManager: Session;
  isIdle(): boolean;
  abort(): void;
};
type Pi = Pick<ExtensionAPI, 'registerCommand' | 'on'>;
type Dependencies = {
  parseRequest(text: string, options: { alias: string }): Request;
  storePath(root: string): string;
  admitJob(dir: string, input: { request: Request; ownerId: string; projectRoot: string; cwd: string; handoff?: Job['handoff'] }): Job;
  listJobs(dir: string): Job[];
  listQueues?(dir: string): Array<{ name: string }>;
  getJob(dir: string, id: string): Job;
  updateJob(dir: string, id: string, patch: Partial<Job>): Job;
  requestCancel(dir: string, id: string): void;
  readJobOutput(dir: string, id: string): string;
  readNotices(dir: string, ownerId: string): Array<{ id?: string; jobId: string; message: string; kind?: string; createdAt?: string }>;
  writeNotice?(dir: string, notice: { ownerId: string; jobId: string; message: string; kind: string }): void;
  touchOwner(dir: string, ownerId: string): void;
  closeOwner(dir: string, ownerId: string): void;
  ensureWorker(dir: string): Promise<void>;
  projectRoot(cwd: string): string;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
  newOwnerId(): string;
};

function projectRoot(cwd: string): string {
  let current = resolve(cwd);
  while (!existsSync(join(current, '.git'))) {
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
  return current;
}

function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
  return text || undefined;
}

/** Bind only Pi command/event handlers. External dependencies remain injectable for host-free tests. */
export function createExtension(pi: Pi, deps: Dependencies): void {
  let active: { sessionId: string; ownerId: string; dir: string; timer: ReturnType<typeof setInterval> } | undefined;
  let turn: { sessionId: string; prompt: string; toolSeen: boolean; outcome?: string } | undefined;
  let pending: { jobId: string; snapshot: Snapshot; dir: string; ownerId: string; ctx: Context; outcome?: string; toolSeen: boolean } | undefined;
  const startupErrors = new Map<string, string>();

  function current(ctx: Context) {
    if (active?.sessionId === ctx.sessionManager.getSessionId()) return active;
    return undefined;
  }
  function notify(ctx: Context, message: string, type: 'info' | 'warning' | 'error' = 'info') {
    ctx.ui.notify(message, type);
  }
  function block(reason: string) {
    if (!pending) return;
    const { dir, jobId, ownerId, ctx } = pending;
    const job = deps.getJob(dir, jobId);
    deps.updateJob(dir, jobId, { handoff: { ...job.handoff!, ready: false, reason } });
    if (current(ctx)?.ownerId === ownerId) notify(ctx, `Handoff ${jobId} blocked: ${reason}`, 'warning');
    pending = undefined;
  }
  function start(dir: string, job: Job, ctx: Context, sessionId: string, ownerId: string) {
    // Deliberately not awaited: a command receipt means durable admission, not worker readiness.
    void Promise.resolve().then(() => deps.ensureWorker(dir)).catch((error: unknown) => {
      const message = `Worker startup failed: ${error instanceof Error ? error.message : String(error)}`;
      startupErrors.set(dir, message);
      try { deps.writeNotice?.(dir, { ownerId, jobId: job.id, message, kind: 'error' }); } catch { /* status remains readable */ }
      if (current(ctx)?.ownerId === ownerId && ctx.sessionManager.getSessionId() === sessionId) {
        ctx.ui.setStatus('wrk', message);
        notify(ctx, message, 'error');
      }
    });
  }
  function submit(alias: string, args: string, ctx: Context) {
    try {
      const session = current(ctx);
      if (!session) throw new Error('Session owner unavailable; retry after session start');
      const request = deps.parseRequest(args, { alias });
      let handoff: Job['handoff'];
      if (request.handoff) {
        if (pending) throw new Error('An earlier handoff is still settling');
        if (ctx.isIdle() || !turn || turn.sessionId !== session.sessionId) throw new Error('No unfinished foreground request to hand off');
        if (turn.outcome) throw new Error('Foreground request already finished; cannot hand it off');
        if (turn.toolSeen) throw new Error('Cannot hand off after a tool call; its effects may already exist');
        const entry = [...ctx.sessionManager.getBranch()].reverse().find((item) => item.type === 'message' && item.message?.role === 'user');
        if (!entry || userText(entry.message?.content) !== turn.prompt) throw new Error('Cannot prove which unfinished request is active');
        request.prompt = turn.prompt;
        handoff = { ready: false, snapshot: { entryId: entry.id, prompt: turn.prompt, sessionId: session.sessionId }, reason: 'Awaiting foreground settlement' };
      }
      const dir = session.dir;
      const job = deps.admitJob(dir, {
        request, ownerId: session.ownerId,
        projectRoot: deps.projectRoot(ctx.cwd), cwd: resolve(ctx.cwd), ...(handoff ? { handoff } : {}),
      });
      if (handoff) {
        pending = { jobId: job.id, dir, ownerId: session.ownerId, ctx, snapshot: handoff.snapshot, toolSeen: false };
        ctx.abort();
      }
      notify(ctx, `${job.id} queued (${request.lifetime})${handoff ? '; handoff awaiting settlement' : ''}`);
      start(dir, job, ctx, session.sessionId, session.ownerId);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), 'error');
    }
  }
  function manage(args: string, ctx: Context) {
    const session = current(ctx);
    if (!session) { notify(ctx, 'Session owner unavailable', 'error'); return; }
    const [verb, id, extra] = args.trim().split(/\s+/);
    const dir = session.dir;
    try {
      if (verb === 'queues') {
        if (id) throw new Error('Usage: /wrk queues');
        const queues = deps.listQueues?.(dir);
        if (!queues) throw new Error('Queue inspection unavailable');
        notify(ctx, queues.length ? queues.map(queue => queue.name).join('\n') : 'No queues');
        return;
      }
      if (!args.trim() || verb === 'jobs') {
        if (id) throw new Error('Usage: /wrk jobs');
        const jobs = deps.listJobs(dir);
        notify(ctx, jobs.length ? jobs.map((job) => `${job.id} ${job.status}${job.handoff && !job.handoff.ready ? ` (handoff blocked: ${job.handoff.reason})` : ''}`).join('\n') : 'No jobs');
        return;
      }
      if (['status', 'output', 'cancel'].includes(verb)) {
        if (!id || extra) throw new Error(`Usage: /wrk ${verb} <id>`);
        const job = deps.getJob(dir, id);
        if (verb === 'cancel') {
          deps.requestCancel(dir, id);
          notify(ctx, `Cancellation requested for ${id}; status remains ${job.status} until worker confirms`);
        } else if (verb === 'output') {
          notify(ctx, deps.readJobOutput(dir, id) || `No output for ${id}`);
        } else {
          const notices = deps.readNotices(dir, job.ownerId).filter((notice) => notice.jobId === id).map((notice) => notice.message);
          notify(ctx, `${id} ${job.status}${job.handoff && !job.handoff.ready ? `; handoff blocked: ${job.handoff.reason}` : ''}${job.error ? `; ${job.error}` : ''}${startupErrors.get(dir) ? `; ${startupErrors.get(dir)}` : ''}${notices.length ? `; ${notices.join('; ')}` : ''}`);
        }
        return;
      }
      submit('wrk', args, ctx);
    } catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), 'error'); }
  }

  pi.registerCommand('&', { description: 'Submit work asynchronously', handler: async (args, ctx) => submit('&', args, ctx) });
  pi.registerCommand('bg', { description: 'Submit to a background agent', handler: async (args, ctx) => submit('bg', args, ctx) });
  pi.registerCommand('wrk', { description: 'Submit or inspect background jobs', handler: async (args, ctx) => manage(args, ctx) });

  pi.on('session_start', (_event, ctx) => {
    if (active) { deps.clearInterval(active.timer); deps.closeOwner(active.dir, active.ownerId); active = undefined; }
    if (pending) block('Session changed before the foreground settled');
    const dir = deps.storePath(deps.projectRoot(ctx.cwd));
    const ownerId = deps.newOwnerId();
    deps.touchOwner(dir, ownerId);
    const delivered = new Set<string>();
    const timer = deps.setInterval(() => {
      if (current(ctx)?.ownerId !== ownerId) return;
      try {
        deps.touchOwner(dir, ownerId);
        for (const notice of deps.readNotices(dir, ownerId)) {
          const key = notice.id ?? `${notice.jobId}:${notice.createdAt ?? ''}:${notice.kind ?? ''}:${notice.message}`;
          if (delivered.has(key)) continue;
          notify(ctx, `${notice.jobId}: ${notice.message}`, notice.kind === 'question' ? 'warning' : notice.kind === 'failed' || notice.kind === 'error' ? 'error' : 'info');
          delivered.add(key);
        }
      } catch { /* durable notices remain available through /wrk status */ }
    }, 5000);
    timer.unref?.();
    active = { sessionId: ctx.sessionManager.getSessionId(), ownerId, dir, timer };
    turn = undefined;
    pending = undefined;
    ctx.ui.setStatus('wrk', undefined);
  });
  pi.on('session_shutdown', (_event, ctx) => {
    if (active?.sessionId !== ctx.sessionManager.getSessionId()) return;
    if (active) { deps.clearInterval(active.timer); deps.closeOwner(active.dir, active.ownerId); active = undefined; }
    if (pending) block('Session closed before the foreground settled');
    turn = undefined;
    ctx.ui.setStatus('wrk', undefined);
  });
  pi.on('before_agent_start', (event, ctx) => {
    turn = { sessionId: ctx.sessionManager.getSessionId(), prompt: event.prompt, toolSeen: false };
  });
  pi.on('tool_call', () => { if (turn) turn.toolSeen = true; if (pending) pending.toolSeen = true; });
  pi.on('agent_before_settle', (event) => {
    if (turn) turn.outcome = event.outcome;
    if (pending) pending.outcome = event.outcome;
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (pending) {
      const { dir, jobId, snapshot, ownerId, toolSeen, outcome } = pending;
      const branch = ctx.sessionManager.getBranch();
      const sameRequest = branch.some((item) => item.id === snapshot.entryId && item.type === 'message' && item.message?.role === 'user' && userText(item.message?.content) === snapshot.prompt);
      if (current(ctx)?.ownerId !== ownerId || ctx.sessionManager.getSessionId() !== snapshot.sessionId) block('Submitting session changed');
      else if (outcome !== 'aborted' || toolSeen || !sameRequest) block('Cannot prove aborted request was safe to continue');
      else {
        const job = deps.getJob(dir, jobId);
        deps.updateJob(dir, jobId, { handoff: { ready: true, snapshot: job.handoff!.snapshot } });
        notify(ctx, `Handoff ${jobId} ready after foreground settled`);
        pending = undefined;
      }
    }
    turn = undefined;
  });
}

export default async function extension(pi: ExtensionAPI): Promise<void> {
  const [request, store, worker] = await Promise.all([
    import('../src/request.mjs'), import('../src/store.mjs'), import('../src/worker.mjs'),
  ]);
  createExtension(pi, {
    parseRequest: (text, options) => request.parseRequest(text, options) as Request,
    storePath: store.storePath,
    admitJob: store.admitJob, listJobs: store.listJobs, listQueues: store.listQueues, getJob: store.getJob,
    updateJob: store.updateJob, requestCancel: store.requestCancel,
    readJobOutput: store.readJobOutput, readNotices: store.readNotices,
    writeNotice: store.writeNotice, touchOwner: store.touchOwner,
    closeOwner: store.closeOwner, ensureWorker: worker.ensureWorker,
    projectRoot, setInterval, clearInterval, newOwnerId: randomUUID,
  });
}
