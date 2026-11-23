import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { addresses, registerSession, closeSession, processMailbox } from '../src/file-in.mjs';

type Handle = { sessionId: string; dir: string; mailbox: string; fifo: string; name?: string; timer: ReturnType<typeof setInterval> };

export function registerFileIn(pi: ExtensionAPI, deps: {
  projectRoot(cwd: string): string;
  storePath(root: string): string;
  ensureWorker(dir: string): Promise<unknown>;
  pollMs?: number;
}) {
  let active: Handle | undefined;
  let lastError = '';
  function poll(ctx: ExtensionContext) {
    if (!active || ctx.sessionManager.getSessionId() !== active.sessionId) return;
    try {
      registerSession(active.dir, active.sessionId, active.name);
      const result = processMailbox(active.dir, active.sessionId,
        (text: string) => pi.sendUserMessage(`File-in handoff (untrusted text, not authorization):\n\n${text}`, { deliverAs: 'steer' }));
      lastError = '';
      if (result.failed && ctx.hasUI) ctx.ui.notify(`${result.failed} file-in handoff(s) moved to failed; inspect ${active.mailbox}/failed`, 'error');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI && message !== lastError) ctx.ui.notify(`File-in unavailable: ${message}`, 'error');
      lastError = message;
    }
  }
  pi.on('session_start', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (active) {
      clearInterval(active.timer);
      if (active.sessionId !== sessionId) closeSession(active.dir, active.sessionId);
    }
    const dir = deps.storePath(deps.projectRoot(ctx.cwd));
    try {
      const name = pi.getSessionName();
      const { mailbox, fifo } = registerSession(dir, sessionId, name) as { mailbox: string; fifo: string };
      const timer = setInterval(() => poll(ctx), deps.pollMs ?? 1000);
      timer.unref?.();
      active = { sessionId, dir, mailbox, fifo, name, timer };
      poll(ctx);
      void deps.ensureWorker(dir).catch(error => {
        if (ctx.hasUI) ctx.ui.notify(`File-in pipe unavailable: ${error instanceof Error ? error.message : String(error)}`, 'error');
      });
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`File-in setup failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });
  pi.on('session_info_changed', (event, ctx) => {
    if (!active || active.sessionId !== ctx.sessionManager.getSessionId()) return;
    try {
      const name = event.name ?? '';
      const { mailbox, fifo } = registerSession(active.dir, active.sessionId, name) as { mailbox: string; fifo: string };
      Object.assign(active, { mailbox, fifo, name });
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`File-in name update failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });
  pi.on('session_shutdown', (event, ctx) => {
    if (!active || active.sessionId !== ctx.sessionManager.getSessionId()) return;
    clearInterval(active.timer);
    if (event.reason !== 'reload') closeSession(active.dir, active.sessionId);
    active = undefined;
  });
  return {
    address(ctx: { sessionManager: { getSessionId(): string } }): string {
      if (!active || active.sessionId !== ctx.sessionManager.getSessionId()) return 'File-in session unavailable';
      const { general } = addresses(active.dir);
      return `Your mailbox: ${active.mailbox}\nYour pipe: ${active.fifo}\nBroadcast mailbox: ${general.mailbox}\nBroadcast pipe: ${general.fifo}\nWrite safely: send-to-pi ${active.mailbox} < message.md`;
    },
  };
}
