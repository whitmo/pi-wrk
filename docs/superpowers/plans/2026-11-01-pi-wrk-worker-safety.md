# pi-wrk Worker Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate workers, queued work launching after cancellation, and work launched past corrupt job records.

**Architecture:** Worker ownership is claimed only after the old worker is provably dead. Cancellation and the queued-to-running transition share the same per-job lock. Scheduler reads strict job records while inspection remains permissive.

**Tech Stack:** Node.js ESM, YAML store, node:test.

**Spec:** `docs/superpowers/specs/2026-11-01-pi-wrk-logic-background-failover-design.md`; the pre-road-test review is recorded in the task history.

## Global Constraints

- Do not signal or replace a live worker just because its ping times out.
- Cancellation acknowledged while a job is still queued prevents the transition to running.
- A corrupt job entry stops all new execution; inspection may still list healthy jobs.
- Preserve worker protocol version 2 and named-job behavior already integrated.
- Work in `pi-wrk/.agents/worktrees/` on a named branch; no live infrastructure changes.

## Review Focus

- The old worker's PID is live but socket blocked: no new worker launches.
- The old worker PID is dead and lock aged: a new worker may take over.
- Cancel and launch contend simultaneously: either cancellation wins and no process starts, or start wins and cancellation is treated as running cancellation.
- A missing owner lease before the queued-to-running claim: no launch.
- One corrupt record plus one healthy queued job: strict scheduler stops; healthy job does not run.

---

### Task 1: Prove prior worker is dead

**Files:** Modify `src/worker.mjs`, `tests/worker.test.mjs`.

**Interfaces:** A private helper `workerDefinitelyDead(identity)` returns true only for a valid positive PID whose `process.kill(pid, 0)` reports `ESRCH`; `EPERM`, missing or malformed PID, and unexpected errors are *not* proof. Both `ensureWorker` and `ownWorker` use it when a live lock fails its socket ping. Retain the existing delay for recent lock files, but never delete a lock for a live or unverifiable owner.

- [ ] Add live-unresponsive and dead-PID tests; run `node --test tests/worker.test.mjs` and observe failure.
- [ ] Make stale takeover require proof of death; rerun worker tests and commit.

### Task 2: Serialize cancellation with launch

**Files:** Modify `src/store.mjs`, `src/worker.mjs`, `tests/store.test.mjs`, `tests/worker.test.mjs`.

**Interfaces:** Export `claimQueuedJob(storeDir, id, { leaseMs, startStatus })` from store; inside `lockedJob`, reload the record, check status queued, no cancel marker, valid owner lease, and then atomically change status/startedAt. Return the claimed job or `null`. Make all `requestCancel` calls use the same lock (not only expected-name calls). `runWorker.launch` invokes this claim before making a runner call; injected test store implements the same interface. A cancellation after the claim is a running cancellation, not a queued cancellation.

- [ ] Add deterministic store contention tests and injected worker cancellation-at-launch test; run targeted tests and observe failure.
- [ ] Implement the claim and locked cancellation; rerun targeted tests and commit.

### Task 3: Stop on corrupt job history

**Files:** Modify `src/store.mjs`, `src/worker.mjs`, `tests/store.test.mjs`, `tests/worker.test.mjs`, and `docs/devops/prototype.md` for recovery guidance.

**Interfaces:** Export `listWorkerJobs(storeDir)` with strict validation: a matching job filename that cannot be loaded fails the call visibly. Preserve permissive `listJobs` for CLI inspection. Use strict listing throughout scheduler and recovery. A corrupt record must stop worker scheduling, not silently disappear; do not invent a safe outcome for it.

- [ ] Test a corrupt record plus a queued job does not invoke the runner; run targeted tests and observe failure.
- [ ] Implement strict scheduler reads; run `npm test`, `npm run check` and commit.
