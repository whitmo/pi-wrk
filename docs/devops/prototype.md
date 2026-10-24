# Prototype operator notes

## What works in local tests

The extension admits durable jobs without a foreground model turn. The
worker runs explicit shell commands and dispatches Pi agents, routers,
councils and swarms. Named queues persist independently of job records and
run FIFO, one at a time. Agent notices use the real `wrk_message` tool;
owner-session delivery is a UI notification, not a foreground request.
Notices remain inspectable if their session disappears. There is no
interactive reply channel.

Swarms require a clean Git checkout. Two child worktrees and one integration
worktree live under `.agents/worktrees/wrk-*`. Local Git exclusions keep
these generated paths out of the submitting checkout's status without
changing tracked `.gitignore`. Child branches must retain their expected
identity, have no uncommitted changes and descend from the starting commit.
One integration worktree cherry-picks their commits. Nothing merges into
main or the submitting branch. Conflicts retain the unresolved worktree;
inspect the job error and its retained paths. Worktrees are not removed
automatically.

## Focus awareness

Context-only inheritance is on by default when the submitting branch has
an active pi-focus v1 binding. Each job retains an immutable snapshot;
clearing or switching the parent's focus does not retarget queued work.
Children inherit their parent's snapshot, not a focus inferred from the
worker process or another checkout. `--focus none` opts out per job.

Full activation requires explicit `--focus active` and a trusted absolute
`PI_WRK_FOCUS_EXTENSION` path in the submitting process. Use the pi-focus
main entry with its adjacent v1 `focus-session.mjs`. The worker checks
compatibility before invoking Pi. The dedicated child adapter seeds a new
local binding with the child's session identity, then lets pi-focus resume
that snapshot. Its focus event handlers use the source cwd; built-in tools
still operate in the child's cwd. Initialization failures terminate the
child rather than allowing a model to run without the requested binding.

Focus source paths refer to the submitting filesystem. This is local
execution, not a portable export to another machine. Context-only mode
never loads activation declarations. Active mode may enforce the chosen
focus's tool guard, but does not load unrelated extensions or invoke
presets/runbooks. Keep the configured extension and its dependencies
installed while jobs are queued. Workers do not hot-reload: use one launched
from this revision, not an older worker that ignores the new focus field.

An offline probe with the installed Pi CLI and pi-focus extension restored
a synthetic captured binding, received a successful resume acknowledgement
and registered `focus_create`. No prompt or model request was sent. This
proves startup integration, not authenticated agent execution or live TUI
behavior; those limits below still apply.

## Cancellation and recovery are incomplete

Cancellation requests signal the original process group. A descendant can
escape that group. Even if the original process exits, its descendants
are not proven stopped. All real running cancellations become `uncertain`,
not `cancelled`. Escaped processes retaining output pipes cannot make the
runner wait indefinitely after cancellation.

After a worker restarts, records that were running or routing also become
`uncertain`. The worker never adopts or signals a process using a stored
PID. Unknown jobs are not replayed. Any uncertain job blocks every new
launch in the same store. Existing active jobs may still finish.

There is no automated resolution command. An operator must first identify
and stop any surviving work, inspect its changes and confirm the outcome.
Only then may its job record be resolved to an appropriate final status.
Do not delete the record or change its status just to unblock scheduling.
If survivors cannot be identified confidently, leave the barrier in place.
The original descendant-confirmation requirement remains unfinished.

Readiness uses a token/socket handshake, not PID liveness. A recent stale
lock waits through the startup grace period before reclamation. Lock data
and job records are YAML under `.agents/wrk`. The transient Unix socket
uses an ownership-checked private `/tmp/pi-wrk-<uid>/` directory with a
hash of the absolute store path: macOS socket paths are too short for
arbitrary checkout paths. Do not remove the socket while a worker owns it.

## What still needs proof or a decision

- Authenticated Pi agent/model execution. The installed CLI was reached,
  but the live smoke run failed with HTTP 401. An operator must refresh
  credentials without putting them in this repository.
- Actual Pi UI lifecycle and foreground handoff behavior. Tests use the
  host SDK types, fake contexts and real YAML storage; they are not live
  TUI evidence.
- A genuine shared todo-provider adapter. `/& todo` fails explicitly;
  no tasks are read or completed by that runner today.
- Reliable descendant containment, restart reattachment and an operator
  resolution flow for uncertain work.

No global Pi settings are changed, and no running session is reloaded.
Use the explicit package/extension loading described in the README.
