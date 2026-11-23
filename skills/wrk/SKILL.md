---
name: wrk
description: Use when submitting or inspecting pi-wrk jobs, selecting an agent, shell, queue, swarm or council, changing job lifetime, or requesting cancellation.
---

# Background jobs

When invoked with a task as `/skill:wrk <task>`, pi-wrk intercepts the raw
input and admits one job. If this skill arrives already expanded as a
`<skill name="wrk">` block with a trailing task, call `wrk_submit` **once**
with `input` set to the exact trailing task (including any selector).
If it is labeled `Skill input:`, pass its value without the label. Report
the returned job ID, or the admission error. Do not ask the user to retype
`/bg` or `/&`, guess model aliases, or execute the task in the foreground.
If `wrk_submit` is unavailable, say admission is unavailable and preserve
the unsubmitted request; never claim a job was queued.

Use direct Pi slash commands. `/& <prompt>` asks a background router to
choose agent, council, or swarm. `/bg <prompt>` and `/& bg <prompt>` use a
background agent. `/wrk <prompt>` also submits to the router. Submission
checks worker readiness first; a queued receipt means durable admission,
not completion. Do not make the foreground agent plan or execute the
submitted prompt.

| Command | Effect |
| --- | --- |
| `/& a:{name: ari, model: provider/model} <prompt>` | Named agent and model; unknown definitions fail |
| `/& sh:{command: "npm test"}` | Explicit shell process in the submission cwd |
| `/&& <task>` / `/|| <task>` | Run after the preceding root succeeds / fails |
| `/~&& <task>` / `/~|| <task>` | Require an explicit agent semantic success / failure verdict |
| `/& q:{name: review} <prompt>` | FIFO named queue; add an agent or shell selector after the queue if needed |
| `/& council <prompt>` | Two independent read-only assessments, then synthesis |
| `/& swarm <prompt>` | Two child assignments, then synthesis |
| `/& todo` | Requires a configured shared todo-provider adapter; currently unavailable by default |
| `/wrk btw <question>` | Ask the existing BTW side thread without leaving this session; requires pi-btw |
| `/wrk` or `/wrk jobs` | List current project's jobs |
| `/wrk status <id>` / `/wrk output <id>` | Inspect state, notices or bounded output |
| `/wrk cancel <id>` | Request cancellation; check status for the final outcome |

In composer input, leading `&`, `&&`, `||`, `~&&`, or `~||` works
without `/`. A trailing ` &` backgrounds just that line; use
`<& type=swarm model="provider/model"> task </&>` to mark one span.
Only one background form is allowed per input. See `and-do`, `or-do`,
and `until-true` for bounded logical workflows, not automatic loops.

A leading `--lifetime independent` keeps a job alive after the submitting
session closes; the default `session` lifetime uses a heartbeat lease,
even for jobs in a named queue. Reloading the Pi extension retains the same
session lease; quit or session replacement closes it. A compatible worker
update starts a ready replacement while old active jobs and workflow children
drain. Queued and new roots move after readiness. Check `/wrk status` or
`worker.log` if replacement startup fails; the old worker keeps serving.
A pre-upgrade token-only worker cannot hand off: wait for its work to drain
and arrange a safe manual stop before retrying. The project store is `.agents/wrk/` and
is local private runtime data, not Git state. Reconnect via `/wrk` in the
same project. Inspect a BTW result with `/wrk status <id>` or
`/wrk output <id>`; open `/btw` to follow up in its retained side thread.
BTW jobs require the submitting session and cannot run independently.
Bare `/&` and `/bg` hand off only a provably unfinished
foreground request; see `bg` for the duplicate-mutation limit.
