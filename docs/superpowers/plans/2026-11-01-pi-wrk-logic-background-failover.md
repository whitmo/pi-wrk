# pi-wrk conditional work implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable conditional jobs, safe background prompt forms, bounded logical composition and model failover.

**Architecture:** Add job-to-job dependency and verdict fields to the existing private YAML store; let the worker gate launch by the recorded predecessor. Parse prompt forms at the extension boundary and retry eligible provider failures within the agent runner. Skill instructions compose these primitives rather than maintaining their own job state.

**Tech Stack:** Node.js 22, ESM, TypeScript Pi extension, YAML, node:test.

**Spec:** `docs/superpowers/specs/2026-11-01-pi-wrk-logic-background-failover-design.md`

## Global Constraints

- Three total model attempts at most, initial selection included; never replay after a tool starts or its status is unknown.
- Dependency scope is the preceding root job submitted by the same Pi session, not the latest project job.
- Cancelled, uncertain and missing-semantic-verdict outcomes never satisfy conditional edges.
- Work in separate `pi-wrk/.agents/worktrees/` branches and integrate through a named branch, never local main.

## Review Focus

- Two sessions submit concurrently: one session's preceding job alone controls its chain; test in Task 1.
- Worker restart between queued predecessor and successor: conditional result survives; test in Task 1.
- Malformed `<&>` and mixed foreground/background prompt: no duplicate foreground work; test in Task 2.
- First model failure after a tool begins: no replay even if later candidates exist; test in Task 3.
- A predicate that remains false: bounded loop ends without deployment; test in Task 4.

---

### Task 1: Durable conditional jobs and semantic verdict

**Files:** Modify `src/request.mjs`, `src/store.mjs`, `src/worker.mjs`, `extensions/index.ts`, `extensions/runner-messages.ts`; test `tests/request.test.mjs`, `tests/store.test.mjs`, `tests/worker.test.mjs`, `tests/extension.test.mjs`.

**Interfaces:** Parser yields optional condition (`&&`, `||`, `~&&`, `~||`). Store admission records immutable predecessor ID and condition. Worker gates until predecessor is terminal; on mismatch marks successor skipped with a readable reason; only explicit structured verdict qualifies for semantic edges. Extension binds predecessor from its active owner/session at submission, including rapid consecutive admissions. Preserve existing handoff and child behavior.

- [ ] Write failing parser/store/worker/extension tests for the four edges, ambiguity, restart, cancellation, and concurrent owners.
- [ ] Run `node --test tests/request.test.mjs tests/store.test.mjs tests/worker.test.mjs tests/extension.test.mjs` and confirm the new tests fail.
- [ ] Implement minimal durable parsing, binding, reporting and gating with no cross-owner dependency.
- [ ] Rerun the same tests, confirm pass, and commit only this task's files.

### Task 2: Ampersand input forms

**Files:** Modify `extensions/index.ts`, create `src/input-syntax.mjs` if parsing needs a separate seam; test `tests/extension.test.mjs`, `tests/input-syntax.test.mjs` if created.

**Interfaces:** Input event converts leading `&`, trailing-line `&`, and `<& type=... model=...>...</&>` into one explicit background admission while preserving unrelated text; existing slash commands and bare handoff unchanged. Invalid attributes/markup produce a visible error without accidental submission.

- [ ] Write failing input tests including a mixed foreground prompt and malformed markup.
- [ ] Run targeted node:test files and confirm fail.
- [ ] Implement parsing and registration using Pi's documented input-event contract.
- [ ] Rerun targeted tests, confirm pass, and commit only this task's files.

### Task 3: Safe model failover

**Files:** Modify `src/runners.mjs`; add focused helper only if necessary; test `tests/runners.test.mjs`.

**Interfaces:** Choose the initially requested/default model, then comparable authenticated models in Pi's scoped-model selection. Three distinct attempts max; retry only demonstrable model/provider failure before any tool starts. Record attempted models and leave uncertain execution untouched. Unknown explicit model remains an explicit error unless the model existed and failed.

- [ ] Write failing tests for fallback, exhausted candidates, unknown explicit model, tool-started failure, cancellation, and ambiguity.
- [ ] Run `node --test tests/runners.test.mjs`, confirm new tests fail.
- [ ] Implement the bounded selection and safe retry using structured Pi JSON events, not output grep heuristics.
- [ ] Rerun targeted tests, confirm pass, and commit only this task's files.

### Task 4: Logical skills, integration and road test

**Files:** Create `skills/and_do/SKILL.md`, `skills/or_do/SKILL.md`, `skills/until_true/SKILL.md`; modify `README.md`, `docs/devops/prototype.md`; integrate prior commits into this branch.

**Interfaces:** Skills specify real commands and bounded iteration, with no inferred success from an absent verdict. Document current limitations and safe operator decisions.

- [ ] Integrate Tasks 1–3 into named integration branch and resolve extension overlap without changing unrelated behavior.
- [ ] Add skills and concise operator usage; validate skill frontmatter with Pi diagnostics and perform one disposable local chained road test.
- [ ] Run `npm test` and `npm run check` in the clean integration worktree; report any live Pi/auth limitation separately.
- [ ] Review changed files and commit this task's changes. Keep all infrastructure state untouched.
