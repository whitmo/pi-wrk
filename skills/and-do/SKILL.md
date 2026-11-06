---
name: and-do
description: Use when a background task should run only after the previous pi-wrk root job succeeds, or only after its agent explicitly reports semantic success.
---

# And-do

Submit the first job with `/& <task>` (or `/bg <task>`), then submit
`/&& <next task>` in the **same Pi session**. `/&&` starts only if that
session's preceding root job finishes with status `succeeded`. A skipped,
cancelled, failed or uncertain predecessor does not qualify. The next job
can use any normal selector, e.g. `/&& sh:{command: "npm test"}`.

Use `/~&& <next task>` only when the predecessor is a worker-owned agent
that explicitly called `wrk_message` with `verdict: "success"` **and**
finished with status `succeeded`. A successful process exit alone does not
supply a semantic verdict. Without a verdict, the next job is skipped.

Inspect `/wrk jobs` and `/wrk status <id-or-name>` before depending on the
result. These commands create a one-step dependency, not a transaction or
an automatic loop. Do not use a job's summary as proof that deployment is
safe; confirm the test or predicate job actually succeeded.
