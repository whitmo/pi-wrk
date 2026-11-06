# pi-wrk Work-Item Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assign unique readable verb.noun.digit names to pi-wrk jobs and their unnamed worker agents, with an active-job registry for label lookup.

**Architecture:** A shared word parser/generator reads the CSV when the TypeScript extension loads and is also usable in the detached JS worker for child jobs. The existing store retains UUID IDs and atomically claims labels; extension commands resolve active labels back to UUIDs.

**Tech Stack:** Node.js ESM, TypeScript extension, YAML job store, node:test.

**Spec:** `docs/superpowers/specs/2026-11-01-pi-wrk-work-item-names-design.md`

## Global Constraints

- Labels follow lowercase `{verb}.{noun}.{0..9}` from `docs/sorted_short_words.csv` only.
- UUIDs remain durable internal job IDs; legacy jobs still work by UUID.
- A selected `a:{name: ari}` agent definition is not replaced with a display label.
- Names must be unique in a project store across concurrent sessions and worker restarts.
- No client infrastructure changes.

## Review Focus

- Two sessions choose the same random candidate: exactly one reservation wins; the other gets a different label.
- A CSV row is `Noun / Verb`, `Verb / Noun`, or proper name: correct noun/verb pools and valid lowercase names.
- A worker creates routed/swarm children after the extension exits: each child has its own unique label and the agent inherits it.
- An active job finishes between registry listing and `/wrk cancel <label>`: command must fail safely, not target another job.
- A legacy UUID-only job and a completed named job: UUID commands still work; active-label lookup does not mistake history for live work.

---

### Task 1: Generate and claim names

**Files:** Add `docs/sorted_short_words.csv` (copy from the existing untracked source checkout), create `src/names.mjs`, modify `src/store.mjs`, test `tests/names.test.mjs` and `tests/store.test.mjs`.

**Interfaces:** `loadNameWords(path)` yields deduplicated noun/verb pools; `generateName(words, randomIndex?)` yields `verb.noun.digit`; `admitJob(storeDir, { ..., name })` persists a collision-safe unique name or rejects on conflict. Expose `activeJobsByName(storeDir)` or equivalent for active-name lookup. Use an atomic store claim, not a scan-then-write race.

- [ ] Write failing tests for valid CSV categories, digit range, collision under simultaneous admissions, and legacy UUID compatibility.
- [ ] Run `node --test tests/names.test.mjs tests/store.test.mjs` and confirm the new tests fail.
- [ ] Implement the minimal generator, claim, and active registry; retry collisions at the caller without unbounded loops.
- [ ] Rerun targeted tests and commit the CSV plus task files.

### Task 2: Name root and child work, resolve references

**Files:** Modify `extensions/index.ts`, `src/worker.mjs`, `src/runners.mjs` only as needed for agent identity, tests `tests/extension.test.mjs`, `tests/worker.test.mjs`, `tests/runners.test.mjs`.

**Interfaces:** Extension loading reads the CSV through the shared module and defines a TS `generateWorkItemName()` wrapper; root admission assigns a name. Worker creates a fresh name for each child and passes it as worker-owned agent metadata. `/wrk jobs` and notices show name plus UUID; `/wrk status|output|cancel` accept active name or UUID, resolve name to one job ID before doing the action, and reject ambiguous/missing labels. Existing explicit agent definition selection remains intact.

- [ ] Write failing tests for root/child inheritance, concurrent naming, active-label commands, and race-safe completed-job handling.
- [ ] Run targeted extension/worker/runner tests and confirm the new tests fail.
- [ ] Implement extension startup loading, root and child admission, agent metadata and active lookup.
- [ ] Run targeted tests, `npm test`, `npm run check`, then commit the task files.
