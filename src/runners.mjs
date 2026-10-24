import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { integrateSwarm } from './workspaces.mjs';
import { formatFocus, normalizeFocus } from './focus.mjs';

const CAP = 1024 * 1024;
const abortError = () => new Error('job cancelled');

function processRun(command, args, { cwd, signal, emit = () => {}, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '';
    let aborting = false;
    let timer;
    const terminate = (force = false) => {
      if (!child.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') reject(error); }
    };
    const onAbort = () => {
      aborting = true;
      terminate();
      timer = setTimeout(() => {
        terminate(true);
        // Escaped descendants can retain pipes. Do not wait forever or claim
        // they stopped: the worker records an uncertain, blocking outcome.
        child.stdout.destroy(); child.stderr.destroy();
        signal?.removeEventListener('abort', onAbort);
        reject(abortError());
      }, 1000);
      timer.unref();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      const text = chunk.toString();
      output = (output + text).slice(-CAP);
      emit(text);
    });
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); });
    child.once('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (aborting || signal?.aborted) { terminate(true); reject(abortError()); }
      else resolve({ code, signal: sig, output });
    });
  });
}

function completed(result) {
  if (result.code !== 0) throw new Error(`process exited ${result.code ?? result.signal}: ${result.output.slice(-2000)}`);
  let settled = false;
  let assistant;
  for (const line of result.output.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'message_end' && event.message?.role === 'assistant') assistant = event.message;
    if (event.type === 'agent_settled') settled = true;
  }
  if (!settled || !assistant) throw new Error('Pi did not report an agent_settled assistant result');
  if (assistant.stopReason !== 'stop') throw new Error(assistant.errorMessage || `Pi stopped: ${assistant.stopReason}`);
  return assistant.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '';
}

function installedDefinitions(cwd) {
  const definitions = {};
  for (const dir of [join(homedir(), '.pi/agent/agents'), join(cwd, '.pi/agents')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(n => n.endsWith('.md'))) {
      const source = readFileSync(join(dir, name), 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
      if (!match) continue;
      const data = YAML.parse(match[1]);
      if (typeof data?.name === 'string') definitions[data.name] = { ...data, prompt: match[2] };
    }
  }
  return definitions;
}

function installedModels(piCommand) {
  const result = spawnSync(piCommand, ['--offline', '--list-models'], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error(`cannot list Pi models: ${result.error?.message || result.stderr}`);
  return result.stdout.split('\n').slice(1).map(line => line.trim().split(/\s+/).slice(0, 2).join('/'));
}

export function createRunners({ piCommand = 'pi', definitions, availableModels, invoke = processRun, todoAdapter } = {}) {
  async function agent(job, context, extra = {}) {
    const options = { ...job.request.options, ...extra };
    const selected = options.name ? (definitions ?? installedDefinitions(job.cwd))[options.name] : null;
    if (options.name && !selected) throw new Error(`unknown agent: ${options.name}`);
    const model = options.model ?? selected?.model;
    if (model && !(availableModels ?? installedModels(piCommand)).includes(model)) throw new Error(`unknown model: ${model}`);
    const args = ['--mode', 'json', '--no-extensions', '--no-session', '--offline'];
    const focus = normalizeFocus(job.focus);
    const env = context.storeDir ? { ...process.env, PI_WRK_STORE: context.storeDir, PI_WRK_JOB_ID: job.id } : undefined;
    if (focus?.mode === 'active') {
      const { prepareFocusActivation } = await import('./focus-runtime.mjs');
      await prepareFocusActivation(focus);
      if (!env) throw new Error('pi-focus activation requires a persisted worker job');
      args.push('--extension', fileURLToPath(new URL('../extensions/runner-focus.ts', import.meta.url)));
    }
    if (focus) args.push('--append-system-prompt', formatFocus(focus));
    if (env) args.push('--extension', fileURLToPath(new URL('../extensions/runner-messages.ts', import.meta.url)),
      '--append-system-prompt', 'Use wrk_message for concise questions, blockers, guidance or results for the submitting session. A stored message does not imply a reply.');
    const tools = options.tools ?? selected?.tools;
    if (tools) {
      const enabled = Array.isArray(tools) ? [...tools] : tools.split(',').map(name => name.trim());
      if (env && !enabled.includes('wrk_message')) enabled.push('wrk_message');
      args.push('--tools', enabled.join(','));
    }
    if (model) args.push('--model', model);
    if (selected?.prompt) args.push('--system-prompt', selected.prompt);
    if (options.systemInstruction) args.push('--append-system-prompt', options.systemInstruction);
    args.push('--', job.request.prompt);
    const result = await invoke(piCommand, args, { cwd: job.cwd, signal: context.signal, emit: context.emit, env });
    const summary = completed(result);
    return { summary, output: summary };
  }
  async function ask(job, context, instruction) {
    return (await agent({ ...job, request: { runner: 'agent', prompt: `${instruction}\n\nTask:\n${job.request.prompt}`, options: {} } }, context, { model: job.request.options?.model, tools: 'read,grep,find,ls' })).summary;
  }
  async function group(job, context, kind) {
    const council = kind === 'council';
    const proposal = await ask(job, context, council
      ? 'Return ONLY a JSON array of two different assessment perspectives. No markdown.'
      : 'Return ONLY a JSON array of two independent, bounded assignments. No markdown.');
    let assignments;
    try { assignments = JSON.parse(proposal); } catch { throw new Error(`invalid ${kind} assignments`); }
    if (!Array.isArray(assignments) || assignments.length !== 2 || assignments.some(p => typeof p !== 'string' || !p.trim())) throw new Error(`invalid ${kind} assignments`);
    const spaces = council ? null : context.createWorkspaces();
    const children = assignments.map((prompt, index) => context.submitChild({ runner: 'agent',
      prompt: council ? `Read-only assessment (${prompt}): ${job.request.prompt}` : prompt,
      options: council ? { tools: 'read,grep,find,ls' } : { systemInstruction: 'Work only in this isolated Git worktree. Commit only your own changes using git -c commit.gpgsign=false commit. Never change the main branch or other worktrees. Report if you made no commits.' },
    }, spaces?.children[index]));
    const results = await Promise.all(children.map(child => context.getChild(child.id)));
    if (results.some(result => result.status !== 'succeeded')) throw new Error(`${kind} child failed or cancelled${spaces ? `; retained integration ${spaces.integration.branch} at ${spaces.integration.projectRoot}; children ${spaces.children.map(c => `${c.branch} at ${c.projectRoot}`).join(', ')}` : ''}`);
    const report = spaces ? integrateSwarm(spaces) : '';
    const summary = await ask(job, context, `Synthesize these independent ${kind} results. Do not claim unfinished work succeeded.\n${results.map(r => r.summary).join('\n---\n')}\n${report}`);
    return { summary: `${summary}${report ? `\n${report}` : ''}` };
  }
  return {
    agent,
    shell: async (job, context) => {
      const command = job.request.options?.command;
      if (typeof command !== 'string' || !command.trim()) throw new Error('shell requires explicit sh:{command: ...}');
      const result = await invoke('/bin/sh', ['-c', command], { cwd: job.cwd, signal: context.signal, emit: context.emit });
      if (result.code !== 0) throw new Error(`shell exited ${result.code ?? result.signal}: ${result.output.slice(-2000)}`);
      return { summary: `shell exited 0`, output: result.output };
    },
    router: async (job, context) => {
      const selected = (await ask(job, context, 'Select exactly one route from agent, council, swarm. Output ONLY a JSON string such as "agent". Never select shell or todo.')).trim();
      let route;
      try { route = JSON.parse(selected); } catch { throw new Error('invalid route'); }
      if (!['agent', 'council', 'swarm'].includes(route)) throw new Error('invalid route');
      const child = context.submitChild({ runner: route, prompt: job.request.prompt, options: job.request.options });
      const result = await context.getChild(child.id);
      if (result.status !== 'succeeded') throw new Error(`routed child ${result.status}`);
      return { summary: result.summary };
    },
    council: (job, context) => group(job, context, 'council'),
    swarm: (job, context) => group(job, context, 'swarm'),
    todo: async (job, context) => {
      if (!todoAdapter) throw new Error('todo provider unavailable: shared task adapter not configured');
      return todoAdapter(job, context);
    },
  };
}
