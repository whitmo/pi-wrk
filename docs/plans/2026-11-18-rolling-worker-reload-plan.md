# Rolling worker reload implementation plan

Approved design: 2026-11-18-rolling-worker-reload-design.md.

1. Establish baseline with npm test and npm run check in this clean worktree.
2. Add failing behavioral tests for rolling worker handoff and startup retries
   in tests/worker.test.mjs, and reload lease preservation in extension tests.
3. Extend src/worker.mjs worker identity/readiness and scheduling ownership.
   Today ensureWorker only checks protocolVersion, ownWorker holds worker.lock,
   startup marks all running/routing jobs uncertain, and runWorker requires
   child jobs to have a locally active parent. These assumptions must be
   changed deliberately, not bypassed by spawning a second scheduler.
4. Update extensions/index.ts lifecycle handling and dependency wiring.
   session_shutdown(reason=reload) must not close active job ownership.
   Preserve actual quit, replacement-session and BTW behavior.
5. Update bin/pi-wrk.mjs only as needed for worker startup/handoff arguments.
   Diagnose startup failures, bound safe retries, and keep the previous
   scheduler if replacement readiness fails. Handle unsupported old workers
   explicitly without interrupting active jobs.
6. Run focused tests, full npm test and npm run check. Review actual diff for
   ownership races, queue ordering, workflow drain and unsafe retry behavior.
7. Update README/skill guidance to match implemented behavior and limitations.
   Commit only this work. Report evidence and any unresolved compatibility
   limits. Keep the original checkout and live worker untouched.
