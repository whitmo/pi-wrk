import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createJiti } from 'jiti';
import { normalizeFocus } from './focus.mjs';

// Full activation is opt-in; use the installed extension's own v1 validator.
export async function prepareFocusActivation(value) {
  const focus = normalizeFocus(value);
  if (focus?.mode !== 'active') throw new Error('pi-focus activation requires active mode');
  try {
    if (!statSync(focus.extensionPath).isFile()) throw new Error('not a file');
    const jiti = createJiti(import.meta.url);
    const api = await jiti.import(join(dirname(focus.extensionPath), 'focus-session.mjs'));
    const factory = await jiti.import(focus.extensionPath, { default: true });
    if (typeof factory !== 'function' || typeof api.createLocalFocusBinding !== 'function')
      throw new Error('compatible extension factory and v1 binding API required');
    const makeBinding = sessionId => api.createLocalFocusBinding({ agentSessionId: sessionId,
      capturedAt: focus.capturedAt, active: focus.active, last: focus.active });
    makeBinding('wrk-preflight');
    return { focus, factory, makeBinding };
  } catch (error) {
    throw new Error(`pi-focus extension unavailable or incompatible: ${focus.extensionPath}: ${error.message}`);
  }
}

export async function registerInheritedFocus(pi, value, { onStartupError = error => { throw error; } } = {}) {
  const { focus, factory, makeBinding } = await prepareFocusActivation(value);
  pi.on('session_start', (_event, ctx) => {
    try { pi.appendEntry('pi-focus:binding', makeBinding(ctx.sessionManager.getSessionId())); }
    catch (error) { onStartupError(error); }
  });
  // The focus extension restores a real binding, without opening its chooser or
  // resolving against the child's worktree. Built-in tools keep their real cwd.
  await factory({ ...pi, on(name, handler) {
    return pi.on(name, async (event, ctx) => {
      const sourceContext = new Proxy(ctx, { get: (target, key) => key === 'cwd' ? focus.sourceCwd : Reflect.get(target, key) });
      if (name !== 'session_start') return handler(event, sourceContext);
      try { return await handler({ ...event, reason: 'resume' }, sourceContext); }
      catch (error) { onStartupError(error); }
    });
  } });
}
