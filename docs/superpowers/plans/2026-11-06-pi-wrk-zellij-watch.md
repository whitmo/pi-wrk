# Implement one-shot Zellij tab watch

Spec: `docs/superpowers/specs/2026-11-06-pi-wrk-zellij-watch-design.md`
Branch: `feat/tooling-watch-zellij`, isolated worktree under `.agents/worktrees/`.

## 1. Zellij read boundary

Add `src/zellij-watch.mjs`: `readTab(sessionName, { tabName?, tabId? }, run = execFile)` returns `{ tabId, snapshot }`. Use `list-panes -j -t` and viewport-only `dump-screen -p terminal_ID` with explicit `--session`; reject missing/duplicate names and no terminal pane. Hash each pane's dump and sort by pane ID; the resulting snapshot is comparable. No focus-changing commands. Add `tests/zellij-watch.test.mjs` with injected CLI response fixtures; first run tests red, then implement.

## 2. Session watch command

Extend `extensions/index.ts` with `/watch:zellij <tab name>`; read the first snapshot before installing a one-second interval. Poll without overlap; on first changed snapshot clear the interval and call `pi.sendUserMessage` with a follow-up (idle: direct, busy: `{ deliverAs: 'followUp' }`). Stop silently on session end/replacement and warn on tab disappearance or read error. A new watch replaces the old one. Depend on injectable `readTab`, session-name provider, and existing timer functions. Add focused tests in `tests/extension.test.mjs` for unchanged, change exactly once, session shutdown/switch, replacement, and visible errors; run red then green.

## 3. Verify and promote

Update `README.md` and `docs/devops/prototype.md` with the supported behavior and deferred sources. Run focused tests, `npm test`, `npm run check`, and `git diff --check` in the worktree. Review diff, commit on feature branch, merge through named release branch into `whitmo/pi-wrk` (never local `main`), rerun target validation, then remove idle worktree/branches. No remote push or live deployment.
