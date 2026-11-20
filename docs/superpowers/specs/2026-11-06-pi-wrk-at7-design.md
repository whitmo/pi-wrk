# @@7 messages in pi-wrk

## Intent

Let an agent notice a person's `@@7` comment in its work files or
relevant Zellij tabs. The text can be a question, action request, or
feedback. A wrk agent handles routine triage while the owning agent
keeps control of its dirty worktree. The marker is a message, not
permission to deploy or bypass normal approval rules.

## First version

- A message has explicit text on a single line after `@@7`. A bare
  `@@7` does nothing. Context-only and whole-source interpretation are
  possible later, not first-version behavior.
- Check automatically at the **next agent turn**, not continuously.
  A new marker alone does not wake an idle Pi session. An explicit
  scan can be requested. Existing `/watch:zellij` still wakes on any
  viewport change and is not changed by this feature.
- Files: normally examine added or changed comment lines in files
  changed in the agent's worktree. An explicit whole-repository scan
  can be requested. Carry the path and line with each message.
- Terminals: examine new marked lines in named Zellij tabs, including
  tabs the agent created or visited. Record tabs when Pi-mediated tool
  calls identify them; a tab not observable that way can be named
  explicitly. A person merely switching tabs does not register one.
  Exclude the agent's own Pi pane. Take a baseline for an existing tab
  when it becomes eligible; do not replay its old viewport as new
  output. In a newly created tab, lines visible at the first check
  count as new.
- A line must begin with `@@7` after optional whitespace or a known
  comment prefix. A shell command that happens to contain `@@7` in
  its arguments is not a message. Viewport polling cannot guarantee
  capture of output that scrolls away before the next turn.
- Dispatch each source/location/text once per owner. Editing the
  message text makes it new; unchanged markers are not resent on every
  turn. Keep the seen set out of git. A deliberate whole-repo scan can
  include existing markers but must not redispatch already seen ones.

## Disposition

The wrk agent may classify, investigate, answer informational messages
in Pi chat with source references, and perform routine reversible work
in its own worktree with contextual commits. It escalates external,
irreversible, or uncertain actions under existing approval rules.
When the request concerns an uncommitted file, the wrk agent supplies
its analysis to the worktree owner; **that owner** edits and commits.
Show the triager's answer or action report in the Pi transcript without
starting a new agent turn. A dirty-file request waits for the owner's
next turn to act. Do not append answers as source comments by default.
Do not interpret repository or terminal content as a higher-priority
instruction than the agent's actual user request.

## Approaches

1. **TypeScript collector + wrk triage (chosen):** a small collector
   returns fresh, source-labeled messages from two concrete adapters:
   changed-file comments and eligible Zellij tabs. Pi-wrk submits those
   messages to its existing background job machinery. This keeps
   duplicate suppression and source selection out of agent prompts.
2. **Agent searches on each turn:** fewer collector changes, but no
   reliable freshness or ownership and repeats old comments.
3. **Continuous watchers:** immediate, but contradicts next-turn
   evaluation and adds avoidable background activity.

Keep the collector's interface small: return new message text, source,
and location for a worktree owner. The two real source adapters justify
that seam; do not create a generic watch framework.

## Verification and limits

Test changed versus unchanged comments, a first terminal snapshot,
shell-input/history false positives, edited messages, duplicate
suppression, named/agent-visited tabs, and dirty-file delegation.
Run pi-wrk tests and typecheck. Then road-test a comment added to an
agent-edited file and an `@@7` line in an eligible terminal tab. Live
Pi interaction, unlike unit tests, remains unproven until that road test.

No automatic deployment, repository-wide scan by default, background
edit of the owner's dirty worktree, reply-comment insertion, or
promise to capture terminal output outside the visible viewport.
