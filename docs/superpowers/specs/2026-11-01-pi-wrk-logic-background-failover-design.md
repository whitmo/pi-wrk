# pi-wrk conditional work design

Status: self-approved for implementation at the user's request (2026-11-01).

## Intent

Make conditional background jobs dependable across foreground turns and worker restarts; add concise logic skills and background input forms; avoid replaying possible mutations when a model fails.

## Scope and outcomes

- `/&&` or `&&` runs a new job only if the previous *submitted root job in this Pi session* succeeds. `/||` or `||` runs only if it fails. `~&&` and `~||` use an explicit persisted semantic verdict instead of process status. A missing verdict, cancellation or uncertain result never means success or failure. A skipped branch is visible and terminal, not silently dropped. Different sessions do not influence one another. Keep existing `/&`, `/bg`, `/wrk` behavior.
- Workers report semantic `success` or `failure` through a structured, durable result. No output keyword heuristic or second model judge. An ambiguous result has no verdict. Logical skills `and_do`, `or_do`, `until_true` teach users/agents how to express these operations. `until_true` requires bounded iterations, an explicit predicate, and must stop rather than spin on an ambiguous result; demonstrate the example `until (tests pass): (run the tests || fix test failures) && deploy` without deploying before confirmed success.
- Leading `&` behaves as `/&`. Trailing unmarked `&` submits only that line. `<& ...> ... </&>` explicitly marks the submitted text and may specify runner type and model; malformed or unmatched markup must not quietly submit the wrong text. Preserve the rest of a mixed foreground prompt without duplicate execution.
- On a provider/model failure, retry using comparable *available scoped models* up to **three total attempts**, including the initial model; honor explicit model preference first. Never retry after a tool began or when whether a tool began cannot be proved; persist an uncertain outcome, expose it to the owner, and require an operator decision. Do not retry semantic task failures, cancellation, unavailable candidates, or arbitrary shell commands. Record attempted models and errors without credentials.

## Constraints and exclusions

Store remains private, Git-ignored YAML. No Git-stored credentials, applied state, or running process data. Existing owner lifetime, queue ordering, handoff safety and child depth remain intact. No client infrastructure changes. CLI-only smoke checks do not establish live TUI behavior; label live road-test outcomes honestly.

## Approaches

1. **Engine-owned (selected):** scheduler persists dependencies/verdicts; extension handles input syntax; runner owns safe model retry; skills guide composition. Testable after restarts, but touches store, scheduler and runner.
2. **Prompt-only:** skills ask an agent to inspect output and submit follow-ups. Cheaper initially but can lose a chain when a session closes or misjudge a failure.
3. **External workflow daemon:** separate state engine in front of pi-wrk. Clear isolation, but duplicates the existing worker and store; too large for this prototype.

## Implementation ownership

One integration branch owns shared contracts and documentation. Isolated worktrees implement (1) dependencies and semantic verdict, (2) input syntax, (3) model retry. Integrate and test together; add logic skills after the job protocol is stable. Road test in a disposable local project, not production infrastructure.
