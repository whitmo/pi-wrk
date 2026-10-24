# Implementation contract

Approved source: docs/superpowers/specs/2026-10-23-pi-wrk-design.md.
Work only on your assigned files/branch; no subagents. Each contributor
commits its own work, with a short evidence-backed result. Integration
owner cherry-picks; no main branch writes. Node >=22, ESM .mjs core,
TypeScript Pi extension. YAML/Markdown persisted data; runtime gitignored.
Use node:test and tests proving behavior, not static manifest assertions.

## Module contracts (binding between contributors)

`src/request.mjs` exports `parseRequest(text, { alias = '&' } = {})`.
Returns `{ runner, prompt, options, queue, lifetime, handoff }`:
runner = agent|shell|router|swarm|council|todo; options is plain object;
queue string|null; lifetime session|independent (default session);
handoff true only when blank input for &/bg (runner agent, prompt empty).
/bg and /& bg default agent; /& plain defaults router. Explicit selectors
`a:{name: ..., model: ...}`, `q:{name: ...}`, `sh:{command: ...}` use YAML
flow mappings; supported bare keywords swarm, council, todo, bg.
Lifetime flag only at beginning `--lifetime session|independent`.
Preserve prompt text after parsing control prefix; reject malformed maps,
unknown keys, invalid lifetimes, empty explicit tasks, queue path escapes.
`/wrk jobs|status|output|cancel` is command-layer syntax, not parseRequest.

`src/store.mjs` exports:
- `storePath(projectRoot)` -> absolute .agents/wrk path.
- `admitJob(storeDir, { request, ownerId, projectRoot, cwd, handoff? })`
  -> persisted Job, with UUID `id`, request, ownerId, absolute projectRoot,
  cwd, status queued, createdAt, updatedAt; atomic YAML file in jobs/id.yaml.
- `listJobs(storeDir)` -> Job[] newest first.
- `getJob(storeDir, id)` -> Job (throws on missing/invalid id).
- `updateJob(storeDir, id, patch)` -> Job; worker is sole status writer.
- `requestCancel(storeDir, id)` -> void (separate atomic cancellation marker).
- `isCancelRequested(storeDir, id)` -> boolean.
- `touchOwner(storeDir, ownerId)` / `closeOwner(storeDir, ownerId)` -> void.
- `ownerAlive(storeDir, ownerId, { now=Date.now(), leaseMs=15000 }={})` -> bool.
- `readJobOutput(storeDir,id,{maxBytes=16000}={})` -> string tail of output.
- `appendJobOutput(storeDir,id,text)` -> void, bounded retention (1 MiB).
- `writeNotice(storeDir,{ownerId,jobId,message,kind})` -> void.
- `readNotices(storeDir,ownerId)` -> array (durable; no implicit model turn).
All store functions sync. Directories 0700/files 0600; atomic replace;
validate identifiers before any path join. Job id is UUID. ownerId is
safe token <=128 chars. Runtime secrets/data never added to Git.

`src/worker.mjs` exports `ensureWorker(storeDir)` -> Promise<void> resolves
when worker ready or rejects with clear startup error, launched via Node
child_process with explicit argv and detached/unref + file backed logs.
This function is called AFTER admission without awaiting in command handler.
Worker lock identifies PID + unique token/start identity, startup arbitration;
PID-only kill/check is forbidden. No arbitrary process adopted by old PID.
`runWorker({storeDir, pollMs=100, leaseMs=15000, concurrency=3, runners?})`
-> Promise<void>; CLI handles signals; injectable runners for tests.
Runners are keyed by runner kind and signature async `(job, {signal, emit,
submitChild, getChild}) -> { summary?, output? }`; spawn argument arrays.
Handle router/council/swarm/todo explicitly, not fake aliases for one agent.
Children preserve owner, lifetime, project root and cwd, plus parentId.
Never rerun interrupted jobs automatically. Scheduler obeys queue FIFO and
concurrency, including cancellation and session lease expiry while queued.
Shell runner cancellation must terminate and confirm descendants.

`src/runners.mjs`: `createRunners({piCommand='pi', ...options}={})` -> runner map.
Use actual installed CLI docs; no invented APIs. Child resources controlled,
no recursive pi-wrk extension loading; no parent transcript default.
Agent/model lookup must fail unknown definitions, not ignore options.
Todo adapter explicitly unavailable until genuine shared-provider bridge
exists. Never claim successful todo execution with no tasks read/updated.
Record limitation as blocker, implement interface/tests; owner will integrate
provider work or report incomplete rather than hide missing requirement.

`bin/pi-wrk.mjs` launches worker (`worker --store <absolute path>`) and
may expose jobs/status/output/cancel using same store and validation.

`extensions/index.ts` registers &, bg, wrk. Calls above modules, handles jobs
subcommands synchronously, calls ensureWorker in detached promise with catch
notices. UI updates, never send raw work as main prompt, never waitForIdle.
Session owner generated UUID; 5s lease heartbeat; shutdown closes owner.
New session IDs get different owners; stale contexts never used for UI.
Handoff admission requires a continuation snapshot of unfinished request,
then abort foreground and WAIT asynchronously for genuine settle event
before marking handoff ready. Worker must not execute a handoff job until
`job.handoff.ready === true`; any uncertainty is visible blocked admission,
never duplicate replay. Completed requests never replay. Safe implementation
may reject handoff with clear reason until lifecycle proof available, but
that remains a tracked incomplete requirement, not advertised success.

Pi extension tests use fake Pi/session ctx plus jiti. Tests inject adapters
using named export factory if needed; default factory is Pi entry point.
No global settings install/reload without user request. README states tested
vs untested capabilities, setup, selectors/lifetimes and limitations.
