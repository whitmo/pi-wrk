# Rolling worker reload

## Goal

Reloading pi-wrk starts updated code without interrupting active jobs.
Start a replacement, confirm readiness, then transfer queued and new root
jobs. The previous worker finishes its active jobs and exits. Never replay
an active job. Existing workflows must finish, including their children.

On startup failure, inspect the failure, report a useful diagnosis and retry
safely with a bounded policy. The old worker remains available until a
replacement is ready. Do not kill unrelated processes or recover uncertain
work automatically.

## Approaches

- Wait for every active job before restarting: safe, but delays new code.
- Cancel and restart: interrupts jobs and risks repeating partial changes.
- Start a replacement while old jobs finish: selected by the user. Requires
  explicit worker ownership and a safe scheduling handoff.

## Boundaries

The worker is project-wide and shared by sessions. Preserve queue ordering,
concurrency, cancellation, conditional jobs, uncertainty barriers and workflow
children across generations. Reload must preserve the submitting session's
job lease; actual quit/session replacement must retain existing behavior.
Pi exposes session_shutdown.reason, including reload and quit.

Existing workers only provide token ping and protocol matching. A worker
without handoff support must not be forcibly replaced while work is active;
report that compatibility limit rather than claiming a successful handoff.

## Proof

Behavioral tests cover active jobs surviving reload, new work using the
replacement, old worker exit after drain, readiness failure and retry,
concurrent reload requests, queue/workflow safety and owner-lease survival.
No infrastructure changes. No live-job experiment without explicit approval.
