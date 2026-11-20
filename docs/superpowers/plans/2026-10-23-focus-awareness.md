# Focus Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Children receive the submitting session's focus, with optional activation.

**Architecture:** Capture the latest v1 pi-focus binding into an immutable job field. The store/worker propagate it; runners append a bounded context description. An explicit active mode loads only the operator-configured pi-focus entry and restores the captured binding using its v1 resume lifecycle.

**Tech Stack:** Existing Node ESM, TypeScript extensions, YAML store, jiti.

**Spec:** docs/superpowers/specs/2026-10-23-focus-awareness-design.md

## Global Constraints

- Default to context only, with explicit opt-in to full pi-focus activation.
- No live synchronization with the parent.
- No new focus creation or editing workflow.
- No changes to scheduling, cancellation, or todo integration.
- No active focus means today's behavior: no invented or fallback focus.

## Review Focus

- Latest clear/malformed binding must not resurrect an older focus.
- Queued work must retain captured metadata after parent changes.
- Swarm paths must remain anchored to the submitting project.
- Explicit activation must fail if the configured extension is unavailable.
- Context inheritance must never implicitly activate unrelated tooling.

## Task 1: Capture and persist

Files: src/focus.mjs, src/request.mjs, src/store.mjs,
extensions/index.ts; tests/focus.test.mjs, tests/extension.test.mjs.

Interfaces: captureFocus(entries, sourceRoot, sourceCwd, mode,
extensionPath) returns a bounded v1 snapshot or undefined;
normalizeFocus(snapshot) validates stored snapshots;
formatFocus(snapshot) returns context text. admitJob accepts optional focus.

- [ ] Add failing tests for latest binding, absent/cleared focus, malformed
  data, relative references, context mode, active mode config, and snapshot
  detachment from mutable parent data.
- [ ] Run node --test tests/focus.test.mjs and observe failure.
- [ ] Implement helpers, --focus context|active|none prefix parsing,
  command capture, immutable store field and parent inheritance.
- [ ] Run focused tests and commit.

## Task 2: Run and activate

Files: src/runners.mjs, src/worker.mjs, src/focus-runtime.mjs,
extensions/runner-focus.ts; tests/runners.test.mjs,
tests/worker.test.mjs, tests/focus-runtime.test.mjs; package.json/lock.

Interfaces: prepareFocusActivation(snapshot) checks the configured trusted
extension and v1 binding helper before model invocation;
registerInheritedFocus(pi, snapshot) seeds the child's binding before the
focus extension restores it. Only focus handlers see the source cwd.

- [ ] Add failing behavioral tests for runner prompt injection, unchanged
  task text, missing active dependency, actual v1 focus restoration, nested
  router/council children and isolated workspace inheritance.
- [ ] Run focused tests and observe failure.
- [ ] Implement propagation, trusted runner-focus adapter, active-mode
  preflight; move existing jiti dependency to runtime dependencies.
- [ ] Run all tests and typecheck; commit.

## Task 3: Review and PR

Files: README.md, docs/devops/prototype.md.

- [ ] Document default behavior, --focus active opt-in,
  PI_WRK_FOCUS_EXTENSION absolute entry path, absent focus and proof limits.
- [ ] Run offline installed-Pi activation probe without a model call.
- [ ] Review the complete diff and connected code; resolve significant bugs.
- [ ] Run full suite/typecheck in a clean checkout; commit and push only the
  feature branch; open PR against main, documenting live-model proof limits.
