---
name: or-do
description: Use when a background task should run only if the previous pi-wrk root job fails, or its agent explicitly reports semantic failure.
---

# Or-do

Submit the first job with `/& <task>` (or `/bg <task>`), then submit
`/|| <recovery task>` in the **same Pi session**. `/||` starts only if
that session's preceding root job finishes with status `failed`. For
example, `/& sh:{command: "npm test"}` followed by
`/|| bg Fix the test failure` runs the fix only when the test exits
nonzero. A cancelled, skipped or uncertain result is **not** a failure
edge; stop and inspect `/wrk status <id-or-name>` instead.

Use `/~|| <recovery task>` for a *semantic* failure. The predecessor
must finish (`succeeded` or `failed`) and a worker-owned agent must
explicitly call `wrk_message` with `verdict: "failure"`. No verdict,
absence of output, or a failure-looking summary does not satisfy this
edge. `/wrk jobs` and `/wrk output <id-or-name>` show what actually ran.

The recovery job is a new root: a later `/&&` depends on the recovery
job, not the original failure. Verify the original predicate again before
any deployment; fixing a failure is not proof that tests now pass.
