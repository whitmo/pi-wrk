---
name: until-true
description: Use when repeating background check-and-fix work until an explicit predicate passes, with a finite attempt limit and no deployment on uncertain results.
---

# Until-true

Name a runnable predicate and a maximum number of attempts **before**
starting (for example, `npm test`, at most three runs). A shell command
passes when it exits 0; an agent's opinion is not a test result. Inspect
`/wrk status <id-or-name>` and `/wrk output <id-or-name>` after each run.

For `until (tests pass): (run the tests || fix test failures) && deploy`:

1. Run `/& sh:{command: "npm test"}`.
2. If it fails, run `/|| bg Fix the test failures`. Wait for the fix to
   finish, then start a **new test job**. Repeat only within the chosen
   limit. Do not interpret a successful fix job as passing tests.
3. When the latest test job succeeds, submit
   `/&& sh:{command: "<approved deploy command>"}` in the **same Pi
   session**, with that test job as the immediate predecessor.

A later `/||` depends on the latest root, not an earlier test. To retry,
submit the next check as a new root (or `/&&` after a completed fix) and
inspect it; there is no automatic looping syntax. If any job is
`uncertain`, cancelled, or lacks a required semantic verdict, **stop**.
Do not deploy or resubmit possible mutations until the operator checks
survivors and resolves the uncertain state. Stop when attempts are exhausted.
