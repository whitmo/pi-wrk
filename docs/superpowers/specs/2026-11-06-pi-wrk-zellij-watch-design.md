# One-shot Zellij tab watch

`/watch:zellij term` watches the tab named `term` in the invoking Pi
agent's Zellij session. It snapshots that tab immediately and checks
for a later terminal viewport change, including output within the first
second. It rejects tabs containing the agent's own Pi pane to avoid
waking on its UI updates. The first change queues one follow-up
model turn identifying the tab, then stops. It does not start a pi-wrk
worker job. It ends on Pi session shutdown, session switch, or reload.

Use `ZELLIJ_SESSION_NAME` and `ZELLIJ_PANE_ID` to identify the agent's
session and pane, `zellij action
list-panes --json --tab` to find the exact tab and its terminal pane IDs,
and `zellij action dump-screen --pane-id` to read them without changing
focus. Reject missing or ambiguous tab names, missing Zellij session,
tabs with no terminal panes, and the agent's own tab. Poll at most once
a second; avoid concurrent checks. On a missing tab or CLI failure, stop and warn.
A second `/watch:zellij` replaces the prior watch.

A viewport diff approximates output: it does not promise to capture every
byte, detect changes that scroll away between polls, identify the
producing process, or distinguish user-typed text.
Other watch sources (process, PR, command, interactive session) and
persistent jobs are deferred. No new applied infrastructure or secrets.

Acceptance: a named tab's later screen change wakes the originating Pi
agent once; unchanged screens do not; watches stop on session end or
replacement; errors are visible and never change Zellij focus. Unit
tests cover tab selection, wake once, and cleanup. No live Zellij
interaction is required by the automated suite.
