# pi-wrk

Immediate background jobs for Pi. A slash command durably admits a job in
`<project>/.agents/wrk/` and returns without waiting for a model or worker.
A detached local worker owns execution; status, notices and bounded output
remain inspectable after a foreground turn ends. Runtime data is private and
Git-ignored. Node >=22 on macOS or Linux is required.

## Setup

Install dependencies with `npm install` in this directory. Load this
package into Pi explicitly, for example `pi --extension ./extensions/index.ts`;
package installation can expose both the extension and `bg`/`wrk` skills.
The Pi SDK is provided by the Pi host as a peer dependency. Check
`npm test` and `npm run check` before use. This does not change global Pi
settings or reload a running session.

## Commands

- `/bg <prompt>` or `/& bg <prompt>`: use a background agent.
- `/& <prompt>` or `/wrk <prompt>`: route to an agent, council or swarm.
- `/& a:{name: ari, model: provider/model} <prompt>`: explicit agent/model;
  unknown names and unavailable models fail rather than being ignored.
- `/& sh:{command: "npm test"}`: execute an explicit shell command.
- `/& q:{name: review} <prompt>`: enqueue on a FIFO, one-at-a-time queue.
  An agent or shell selector can follow the queue selector.
- `/& council <prompt>` and `/& swarm <prompt>`: bounded two-child work,
  followed by synthesis. Council children use read-only tools. Swarm requires
  a clean Git checkout; children commit on separate worktree branches and
  one integration worktree combines their commits. The submitting checkout
  stays unchanged. Conflicts and all worktrees are retained for inspection.
- `/& todo`: blocked until a real shared todo-provider adapter is wired.
  No task-provider bridge has been confirmed.
- `/wrk` or `/wrk jobs`: list jobs. `/wrk queues` lists persistent queue
  definitions. `/wrk status <id>` includes durable notices and startup
  failures; `/wrk output <id>` reads bounded output; `/wrk cancel <id>`
  requests cancellation. Cancellation is not proof of termination.

Worker-owned agents have a `wrk_message` tool for questions, blockers and
results. The submitting session displays durable notices on its heartbeat,
without injecting a foreground prompt or model turn. Notices remain on disk
if the owner is absent. This is one-way delivery, not a reply channel.

The default `session` lifetime ends with the submitting session's lease,
including queued work. Prefix a request with `--lifetime independent` to
keep it running after the session closes, e.g.
`/bg --lifetime independent Review logs`. A receipt says **queued**, not
running. Jobs are scoped to the resolved project root and retain the
submission cwd. CLI inspection is also available with
`node bin/pi-wrk.mjs jobs --store <absolute-store-path>`.

Bare `/bg` or `/&` means hand off the *unfinished current request* rather
than submit an empty prompt. The extension records its user-entry snapshot,
aborts foreground work, and releases the job only after Pi reports an
aborted settlement. Completed requests are refused. Any tool call before
handoff is refused, since it may already have changed state; uncertainty
leaves a visible blocked job rather than replaying possible mutations.
A model invocation cannot be transplanted. Submit a new explicit prompt
if the conservative handoff guard refuses the request.

## Verification and limits

This is an incomplete prototype, not a fully confirmed cancellation or
recovery service. Cancellation signals the original process group but
cannot prove that escaped descendants stopped. Real running cancellations
and jobs whose worker identity was lost become **uncertain**. That blocks
all new execution in the store, even unrelated jobs. Do not clear this state
until an operator has checked and stopped survivors. Queued cancellation
can be confirmed because no command started. Restart never reruns unknown
work or signals an old PID. See [operator notes](docs/devops/prototype.md).


The node:test suite covers parsing, durable store, worker/runners, command
routing, busy-foreground isolation, startup failures and handoff against
both fake Pi handlers and real YAML storage. `npm run check` typechecks the
TypeScript extension entrypoint against the Pi SDK when the host peer is
available. These checks do **not** prove live Pi UI behavior or a live
model execution; those require operator validation. An integration smoke
run reached the installed Pi CLI but returned HTTP 401 for an expired API
key: authenticated agent execution is not yet verified and needs an
operator credential refresh. No user-message or model-turn injection is
used for ordinary job updates. The default todo
runner reports unavailable until a real provider adapter exists.
