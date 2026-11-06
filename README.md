# pi-wrk

Background jobs for Pi. A slash command checks worker compatibility, then
durably admits a job in `<project>/.agents/wrk/` without waiting for a model.
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
  The planner must return exactly two nonempty JSON strings (for example,
  `["Assess security", "Assess maintainability"]`), not objects. An invalid
  shape gets one corrective planning call before any children or workspaces;
  child execution is never automatically retried. Named reviewers or models
  in prompt prose are not executable selectors; selecting four reviewers is
  a separate feature. Before retrying a failed job, inspect the parent error
  for the child ID, status and underlying cause (and retained worktree paths).
- `/wrk btw <question>`: send a question to the current session's BTW side
  thread without switching focus. Requires pi-btw; completion and errors
  appear under `/wrk status <id>`, and `/wrk output <id>` shows the answer.
  Open `/btw` to follow up in the same side conversation. BTW jobs end when
  their submitting session ends; independent lifetime is not supported.
  In-flight BTW queries cannot be cancelled individually; wait for the
  answer or close the session.
- `/watch:zellij <tab name>`: in this Pi agent's Zellij session,
  snapshot the named tab and wake this agent once when its terminal
  viewport changes, including changes before the first poll. Requires
  `ZELLIJ_SESSION_NAME` and `ZELLIJ_PANE_ID`; the agent's own tab cannot
  be watched. It does not capture every output byte or survive a
  session switch, shutdown, or extension reload. Starting another watch
  replaces the previous one. Other watch sources are not supported yet.
- `/& todo`: blocked until a real shared todo-provider adapter is wired.
  No task-provider bridge has been confirmed.
- `/wrk` or `/wrk jobs`: list jobs and their names. `/wrk queues` lists
  persistent queue definitions. `/wrk status <id-or-name>` includes durable
  notices; `/wrk output <id-or-name>` reads bounded output;
  `/wrk cancel <id-or-name>` requests cancellation. Names resolve only for
  active jobs; UUIDs also work for completed jobs. Cancellation is not
  proof of termination.

`/&&` and `/||` condition a new job on the preceding root job in this Pi
session: success or failure status, respectively. `/~&&` and `/~||`
require an explicit `success` or `failure` semantic verdict from a
worker-owned agent's `wrk_message` tool; an absent verdict satisfies
neither edge. A skipped or uncertain predecessor never starts its child.
For bounded check/fix loops and safe deploy ordering, see the `and-do`,
`or-do` and `until-true` skills. Only one predecessor is tracked; these
commands do not implement automatic loops.

In interactive composer input, a leading `&`, `&&`, `||`, `~&&`, or
`~||` works without `/`. A trailing ` &` sends that line to pi-wrk;
other lines stay in the foreground. Use
`<& type=swarm model="provider/model"> task </&>` to mark a specific
span; `type` also accepts `bg`, `agent`, `council`, or `todo`. Only one
background form is accepted per input. Bare `&` requests the same
conservative foreground handoff as bare `/&`.

Worker-owned agents have a `wrk_message` tool for questions, blockers and
results. The submitting session displays durable notices on its heartbeat,
without injecting a foreground prompt or model turn. Notices remain on disk
if the owner is absent. This is one-way delivery, not a reply channel.

New jobs get unique `verb.noun.digit` names from
`docs/sorted_short_words.csv`; unnamed worker agents inherit their job's
name. Explicit agent definitions such as `a:{name: ari}` are unaffected.
After reloading a new pi-wrk release, an older live worker is not reused or
stopped automatically: wait for its jobs to drain, stop the old worker, then
retry submission. This avoids interrupting active work.

The default `session` lifetime ends with the submitting session's lease,
including queued work. Prefix a request with `--lifetime independent` to
keep it running after the session closes, e.g.
`/bg --lifetime independent Review logs`. A receipt says **queued**, not
running. Named queue jobs run one at a time in admission order, including
jobs created in the same millisecond. Jobs are scoped to the resolved project root and retain the
submission cwd. CLI inspection is also available with
`node bin/pi-wrk.mjs jobs --store <absolute-store-path>`.

Bare `/bg` or `/&` means hand off the *unfinished current request* rather
than submit an empty prompt. The extension records its user-entry snapshot,
aborts foreground work, and releases the job only after Pi reports an
aborted settlement. Completed requests are refused. Any tool call before
handoff is refused, since it may already have changed state; uncertainty
leaves a visible blocked job rather than replaying possible mutations.
A model invocation cannot be transplanted. Submit a new explicit prompt
if the conservative handoff guard refuses the request. Worker-owned Pi
agents retry at most three comparable, authenticated models only when a
provider failure is proven to have occurred before any tool starts.
Possible mutations, ambiguous failures and cancellation are not retried.

## Focus inheritance

Agents inherit the submitting session's active pi-focus v1 binding as a
context snapshot: goals, scope, constraints, notes, references and knowledge
paths. The snapshot is captured when queued and stays the same through
routing, council/swarm children and synthesis. Focus paths point back to
the source project, including when a child runs in another worktree. The
parent conversation and knowledge-base contents are not copied.

No active focus means no inherited context. `/bg --focus none <prompt>`
opts out. Context-only inheritance does not load pi-focus or enable any
focus-declared tools, presets or runbooks.

For an actual child binding and pi-focus functionality, explicitly use
`/bg --focus active <prompt>` (also supported by `/&` and `/wrk`). Before
starting the submitting Pi process, set `PI_WRK_FOCUS_EXTENSION` to the
absolute path of your trusted pi-focus `extensions/index.ts`. That entry
must have the compatible v1 `focus-session.mjs` beside it. Only this chosen
extension is loaded; unrelated extensions remain disabled. Missing focus,
missing files or incompatible binding APIs fail rather than silently
falling back. The path is captured per job, not taken from a stale worker's
environment. Focus declarations still do not invoke presets or runbooks.

`--focus context` explicitly selects the default. Focus and lifetime flags
may appear in either order before the selector/task. Shell jobs do not
inherit focus or support activation. Bare handoff also captures focus.

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
