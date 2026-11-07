# Pi-wrk Messages

Pi-wrk coordinates background work and messages that reach an agent from
its working environment.

## Language

**@@7 message**:
Text marked for an agent's attention in a work file or terminal tab. It
can be a question, action request, or feedback; it is not authorization
for an otherwise restricted action.
_Avoid_: @@7 command, @@7 approval

**Work file**:
A file changed in the agent's worktree and therefore relevant to its
current work.
_Avoid_: Any file in the repository

**Eligible tab**:
A terminal tab the agent created, visited, or explicitly named for
inspection. A tab selected by another person alone is not eligible.
_Avoid_: Active tab

**Worktree owner**:
The agent responsible for editing and committing the work in one
worktree, including its uncommitted files.
_Avoid_: Any agent that can read the worktree

**Triage agent**:
A background agent that interprets an @@7 message and either handles
safe independent work or hands work to the worktree owner.
_Avoid_: Worktree owner

**Agent identity**:
A Pi peer name or session ID used to address a live agent, independent
of its terminal tab.
_Avoid_: Tab address

**@@7 claim**:
An agent's declared responsibility for an @@7 message. A claim is
advisory; it does not prove identity or grant permission.
_Avoid_: Lock, approval

**@@7 author**:
The agent named as the source of an @@7 comment. The comment alone does
not verify who wrote it.
_Avoid_: Verified sender
