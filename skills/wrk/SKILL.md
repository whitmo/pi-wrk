---
name: wrk
description: Use when submitting or inspecting pi-wrk jobs, selecting an agent, shell, queue, swarm or council, changing job lifetime, or requesting cancellation.
---

# Background jobs

Use direct Pi slash commands. `/& <prompt>` asks a background router to
choose agent, council, or swarm. `/bg <prompt>` and `/& bg <prompt>` use a
background agent. `/wrk <prompt>` also submits to the router. Admission is
immediate, while worker readiness and completion are separate. Do not make
the foreground agent plan or execute the submitted prompt.

| Command | Effect |
| --- | --- |
| `/& a:{name: ari, model: provider/model} <prompt>` | Named agent and model; unknown definitions fail |
| `/& sh:{command: "npm test"}` | Explicit shell process in the submission cwd |
| `/& q:{name: review} <prompt>` | FIFO named queue; add an agent or shell selector after the queue if needed |
| `/& council <prompt>` | Two independent read-only assessments, then synthesis |
| `/& swarm <prompt>` | Two child assignments, then synthesis |
| `/& todo` | Requires a configured shared todo-provider adapter; currently unavailable by default |
| `/wrk` or `/wrk jobs` | List current project's jobs |
| `/wrk status <id>` / `/wrk output <id>` | Inspect state, notices or bounded output |
| `/wrk cancel <id>` | Request cancellation; check status for the final outcome |

A leading `--lifetime independent` keeps a job alive after the submitting
session closes; the default `session` lifetime uses a heartbeat lease,
even for jobs in a named queue. The project store is `.agents/wrk/` and
is local private runtime data, not Git state. Reconnect via `/wrk` in the
same project. Bare `/&` and `/bg` hand off only a provably unfinished
foreground request; see `bg` for the duplicate-mutation limit.
