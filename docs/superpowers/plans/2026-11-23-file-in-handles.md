# Named file-in handles implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive Markdown handoffs in named Pi sessions via durable mailboxes and live FIFOs, with a broadcast `general` handle.

**Architecture:** Store runtime files under the project's `.agents/pi/file-in/` (ignored by the parent repository). Each session registers a stable name and polls only its own mailbox. A single worker owns FIFO readers and fans `general` out to live sessions; `send-to-pi` uses atomic mailbox writes and never relies on a FIFO reader. Preserve the recovered CIPR Markdown/processed/failed behavior, without copying its untargeted shared watcher or changing CIPR.

**Tech Stack:** Node.js 22+, Pi extension hooks, POSIX FIFO (`mkfifo`) on macOS/Linux, Node tests. No model or live infrastructure job is needed for verification.

## Global Constraints
- No untargeted consumption: each message has exactly one named recipient or a snapshot of live recipients for `general`.
- Files from untrusted writers must not escape the inbox, turn into code, or act as elevated instructions.
- Direct FIFO writes may block while offline; simultaneous raw writers cannot be framed reliably. The helper provides durable, serialized delivery.
- Acceptance: two sessions cannot steal messages; general fans out to each once; reload retains messages; handled/failed messages archive; all tests and tsc pass.

### Task 1: Durable named mailbox
- [x] Write failing tests for named delivery, broadcast, archive and reload.
- [x] Implement safe paths, registry, atomic writes and session polling in a focused module; wire into pi-wrk extension.
- [x] Run focused tests and type check.

### Task 2: Named live FIFO and helper
- [x] Write failing tests for FIFO single-writer and broadcast, helper stdin/file input and recipient lookup.
- [x] Implement FIFO readers in a singleton worker and durable `send-to-pi` helper; expose handle paths via `/wrk inbox`.
- [x] Run focused tests and type check; document exact direct-FIFO limits.

### Task 3: Integration and review
- [x] Test end-to-end handoff with disposable data and two fake Pi sessions; no real work admitted.
- [x] Run full pi-wrk suite, type-check, and review the diff. External review was requested but pi-wrk admission failed; self-review completed.
