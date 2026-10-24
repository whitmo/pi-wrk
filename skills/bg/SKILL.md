---
name: bg
description: Use when a user wants to move an unfinished request or a new task to a background agent without waiting for the foreground Pi session.
---

# Background work

For a new task, use `/bg <prompt>` directly. The command writes a job before
returning a receipt; it does not send the prompt to the foreground model or
wait for the worker. The default lifetime is `session`: closing the session
cancels its jobs. Use `/bg --lifetime independent <prompt>` only when the
job must survive the session.

Bare `/bg` requests a handoff of the **currently unfinished** foreground
request. It is admitted blocked, aborts foreground activity, and becomes
ready only after Pi confirms an aborted settlement. A completed request,
a request with a tool call, or uncertain settlement stays refused or blocked
to prevent duplicate side effects. Provide a fresh explicit prompt if needed.

Read `/wrk jobs`, `/wrk status <id>`, and `/wrk output <id>` for progress;
`/wrk cancel <id>` requests cancellation, not confirmed termination.
A queued receipt does not prove the worker started. `/wrk status` includes
startup failures and durable notices. See the `wrk` skill for selectors,
queues, and other runners.
