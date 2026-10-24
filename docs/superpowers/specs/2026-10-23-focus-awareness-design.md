# Focus awareness

## Intent

New pi-wrk agents receive the submitting session's focus. Default to
context only, with explicit opt-in to full pi-focus activation.

## Approaches

- Context only: small, preserves child extension/tool isolation, but no
  interactive focus functionality.
- Full activation by default: real binding and functionality, but adds a
  dependency and changes the default child environment.
- Selected: context by default, full activation only when requested.

## Behavior

Capture the active focus and subfocus when admitting the job. Persist the
snapshot with the job, including goals, scope, constraints, reference paths,
and source location. Do not copy the parent's conversation or read all
knowledge-base content. Later parent focus changes do not change that job.

Pass the same snapshot through routing, planning, council/swarm children,
and synthesis, including agents in isolated worktrees. Resolve focus paths
against the submitting project, not the child's worktree.

No active focus means today's behavior: no invented or fallback focus.
Shell jobs do not gain focus functionality.

Provide an explicit per-job opt-in for pi-focus activation. It requires a
compatible installed pi-focus extension; fail clearly when unavailable.
Preserve the captured focus identity. Do not enable unrelated extensions,
tools, loadout presets, or runbooks as a side effect of context inheritance.

## Exclusions

No live synchronization with the parent. No new focus creation or editing
workflow. No changes to scheduling, cancellation, or todo integration.

## Verification

Behavioral tests cover capture, absent focus, queued-job stability, nested
inheritance, worktree paths, and opt-in activation/unavailable dependency.
Run the existing suite and typecheck. Document usage and live-proof limits.
