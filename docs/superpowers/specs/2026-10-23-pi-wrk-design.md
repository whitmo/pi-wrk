# pi-wrk design

Status: approved. Implementation authorized; default lifetime is session-owned.
Bare commands hand off unfinished work. User approved proceeding directly.
Intended repository: `/Users/whit/work/truth-migration/pi-wrk`.

## Purpose

Pi-wrk provides patterns for getting work out of the foreground terminal.
Submitting work must not need a primary-agent model turn, wait for that
agent to finish, or put the submission into its conversation.

The user requested `/&`, `/bg`, `/wrk`, and `bg` and `wrk` skills.
Pi-focus remains separate: shared focus definitions are not agent
assignments. Focus binding and the proposed focus manager are not part
of this initial implementation.

## Chosen approach

The user chose one independent local worker with a thin Pi extension.
The worker owns dispatch, job records, queues, cancellation, and results.
Each job can be session-owned or independent of its submitting session.

Alternative considered: delegate session work to pi-subagents and
pi-processes and add a separate durable runner. That reuses existing
interfaces, but requires reconciling two execution and lifecycle models.
The unified worker was preferred for consistent tracking and queues.

Use TypeScript/Node and the installed Pi SDK/CLI for agent execution.
Use `uv` for any Python commands; Python is not otherwise required.

## Commands and routing

All three commands submit through the same non-blocking entry point:

- `/& <prompt>`: hand off work. A router agent can choose an execution
  pattern when no explicit selector is present.
- `/& bg <prompt>` and `/bg <prompt>`: run the prompt in a background
  agent without foreground involvement.
- `/& a:{name: ari, model: provider/model} <prompt>`: launch an agent
  using explicit options. This YAML flow-map spelling is a proposal for
  making the user's selector notation concrete.
- `/& swarm <prompt>`: delegate independent parts, then consolidate.
- `/& council <prompt>`: obtain independent assessments and synthesize.
- `/& q:{name: review} <prompt>`: enqueue in a named queue, creating it
  when missing. Queues run FIFO, one job at a time initially.
- `/& todo`: ask a background coordinator to triage and work through
  the available todo queue. Use the todo provider's supported interface,
  not foreground-tool impersonation. If unavailable, report that clearly.
- An explicit shell selector will launch a shell/process rather than
  treating shell-looking prose as executable code. Proposed spelling:
  `/& sh:{command: "npm test"}`. Long-running processes are tracked jobs.
- `/wrk <selector or prompt>`: the same dispatch grammar as `/&`.
- `/wrk` or `/wrk jobs`: list jobs; `/wrk status <id>`,
  `/wrk output <id>`, `/wrk cancel <id>` inspect or stop work.

Proposal: `--lifetime session|independent` selects lifetime before the
selector/prompt; default lifetime is `session`. Every
acceptance receipt displays its lifetime.

Bare `/&` and `/bg` need a confirmed contract: the project convention
backgrounds previous work. Proposed behavior is to hand off the current
unfinished request: enqueue a continuation, request foreground abort,
then start the continuation only after foreground execution has settled.
This happens asynchronously; the command does not wait. Do not replay a
completed request or claim that a running model/process was transplanted.
If safe settlement cannot be established, leave the handoff blocked with
a visible reason instead of running duplicate mutations.

The dispatcher recognizes explicit syntax without an LLM. Ambiguous
plain `/&` requests become router jobs; routing latency never holds the
terminal. The router receives the submission and explicit references,
not the entire foreground transcript by default.

## Immediate submission

Registered slash commands run before primary-agent input handling,
including while it streams. Command handlers never call waitForIdle,
await job execution, or send the raw submission as a primary user message.

A local outbox accepts a small YAML submission with a stable job ID using
an atomic write. The command reports `queued` after that write, then
returns. Cold worker startup/reconnection happens asynchronously.
`queued` is not `running`, and worker startup failure remains visible.

Only the worker launches jobs. Submission IDs are deduplicated; a router
result cannot launch the same child twice merely because delivery retries.
A worker lock/lease prevents two workers claiming the same local store.

Use one worker per canonical project store, discovered by an explicit
store path recorded in submissions and worker metadata. Record absolute
project root and execution cwd for every job. The source repository for
pi-wrk is not the job's project. Resolve paths at submission time; never
use the long-lived worker's inherited cwd for later jobs.

Start the installed worker entry point as an independent subprocess with
explicit argv and file-backed logs; the implementation must use supported
process-start APIs rather than shell backgrounding. Establish ownership
before consuming submissions. A startup failure remains in worker status
and job records for `/wrk` to report on reconnect.

## Lifetimes and records

Store project-owned records as YAML or Markdown under `.agents/wrk/`:
job metadata, submissions, queue state, and readable result/log files.
Exclude transient/private runtime data from Git and use restrictive local
permissions. Pi-owned transcripts may retain their native format.

Jobs have `queued`, `routing`, `running`, `succeeded`, `failed`,
`cancelled`, and `interrupted` states, timestamps, owner/session, lifetime,
parent job, backend, process identity, result references, and errors.
A supervisor's acceptance is not evidence of successful execution.

Session jobs use a submitting-session lease, not just a PID. A normal
close cancels them; a lost lease eventually cancels them after a grace
period. Independent jobs and queues continue after terminal closure.
A surviving worker can be reconnected to by another Pi session.
Queue definitions persist independently of their jobs. Each queued job
retains its own lifetime and submitting-session lease: placing a session
job in a persistent queue does not make that job independent.

On worker restart, reconcile existing records with verified runner
identity. Do not blindly rerun shell commands or edits: unknown outcomes
become interrupted and require explicit retry. Do not kill an unrelated
process because an old PID was reused. Cancellation reaches descendants;
terminal status follows confirmed termination/outcome, not the request.

Bound concurrency and output retention. Queue admission, cancellation,
and status updates use a single owning worker; do not build distributed
locking or cross-machine scheduling in this slice.

## Execution patterns

Agents run outside the foreground process with separate histories.
Explicit agent/model options must resolve to installed definitions and
available models; unknown selectors fail rather than silently changing
agent or model. Read-only council members are the default proposal.

Swarm jobs create child assignments, track their outcomes, and synthesize
results. Coding contributors use separate branches/worktrees; one
integration owner combines results. Cancellation covers the whole job
tree. No automatic unbounded recursive spawning.

The first implementation must verify the installed Pi SDK/CLI interfaces
and todo-provider adapter. Existing pi-subagents/pi-processes interfaces
may be reused where their lifecycle fits, but they are not substitutes
for an independent worker's durability.

## Communication and skills

By default show job receipt/status in the UI, without primary-agent
context injection. The handling agent may explicitly send a concise
question, guidance, blocker, or result reference back to the submitting
session. If that session is absent, retain the message for inspection.
UI/inbox delivery is the default, including questions. Triggering a primary
model turn requires explicit opt-in; normal submission and progress do
not wake it. Completion and startup-failure notices are stored durably so
`/wrk` can show them without a surviving submitting terminal.

The `bg` skill describes background dispatch and how to inspect results.
The `wrk` skill describes selectors, queues, council/swarm, todo handling,
job ownership, and status/cancellation. Skills use the worker interface;
they must not turn slash submission into a foreground planning exchange.

## Delivery and verification

Implement in independently reviewable stages on named branches:

1. Parser, YAML job/outbox store, lifecycle contract and behavior tests.
2. Worker, agent/shell runners, leases, restart reconciliation and tests.
3. Extension commands and bg/wrk skills; no foreground model dependency.
4. Named queues, council/swarm and todo adapter, bounded job trees.

The definition of done includes all requested commands and selectors;
intermediate stages must clearly state unsupported execution paths.
No placeholder selector may report successful execution.

Test real behavioral boundaries: parsing and literal prompt preservation,
atomic admission/deduplication, busy-foreground isolation, startup failure,
queue ordering, cancellation, parent exit, reconnect, restart uncertainty,
result delivery, and bounded swarm/todo execution. Use small fake runners
for deterministic tests plus a minimal real-process integration check.
Verify live terminal behavior separately before claiming it works live.

## Boundaries and open items

No remote workers, distributed synchronization, automatic focus manager,
or new memory system. No automatic migration of existing task providers.
Do not expose secrets through cross-session summaries or commit runtime
prompts, outputs, credentials, or live process state.

Confirmed: default lifetime is session-owned, with explicit independent
jobs. Bare commands hand off unfinished work without replaying completed
requests. One local worker and implementation are approved.
Todo provider details and worker packaging are implementation research
items; inability to provide the adapter must be reported, not hidden.
