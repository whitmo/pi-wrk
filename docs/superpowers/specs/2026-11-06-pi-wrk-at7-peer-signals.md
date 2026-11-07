# Agent-addressed @@7 comments

## Goal

An agent can leave a valid source-file comment for another live Pi agent,
without changing executable code. The recipient gets an @@7 triage notice
across isolated worktrees. Unaddressed @@7 keeps its existing behavior.

## Approaches

- **Comments plus Pi's existing peer channel (chosen):** retain the
  comment as the durable source; use the optional intercom extension bus
  to notify a named live recipient. This crosses worktrees without
  watching every checkout. It cannot deliver while the peer channel or
  recipient is offline.
- **Comments alone:** fewer moving parts, but peers in isolated worktrees
  cannot see each other's uncommitted comments.
- **Zellij tab addresses:** a tab may contain another process later and
  is not an agent identity. Do not route by `session:tab`.

## Syntax and meaning

A line must be a valid comment in its host file. Keep the existing
comment prefixes and unchanged `@@7 message` behavior. New tags precede
message text, for example:

```ts
// @@7:@BEACON @@7:+reviewer Can you check the branch?
// @@7:@BEACON @@7:+reviewer @@7::BEACON I am handling this.
```

- `@@7:@id` identifies the intended Pi recipient. An exact, unique
  live agent name or an explicit peer session ID is valid; an ambiguous
  or unknown name is not routed. `sensible-yak:term` is a tab address,
  not an agent ID.
- `@@7::id` is a claim that the named agent is handling the message.
  It is advisory, not an atomic lease, proof of identity, or approval.
- `@@7:+id` is the author claimed by the comment. It is untrusted text;
  the peer channel's sender session ID is the transport provenance.
- Tags may occur together before the text. A bare `@@7:@id` or a
  claim/author tag without message text is not a work request. Keep
  unqualified terminal `@@7` intake as it is; do not put markers into
  shell command arguments or assume zsh treats `#` as an inline comment.

## Delivery

On the next owner turn, collect new or explicitly rescanned comments as
now. An addressed comment is sent only through an available Pi peer
channel, not also to the sender's local triager. Match the recipient
against live Pi peers; never guess from a tab name. The recipient
processes it using existing background triage and own isolated
worktree, with the comment and declared tags labeled lower-trust.
The recipient never edits the sender's dirty checkout. Acknowledge
receipt with the source message key to prevent repeat dispatch after a
same-session reload. If the peer/channel is unavailable or delivery
cannot be confirmed, leave the comment eligible for a later turn and
show a concise delivery warning; do not claim delivery.

A claim does not stop the addressed recipient from *seeing* the message;
it tells the triager somebody says they are handling it. A new comment
text or recipient is a new message. No automatic cross-worktree edits,
no new Zellij polling, no changes to existing unaddressed @@7 or
`/watch:zellij`, and no promise to message short-lived `--no-session`
background agents directly. They can communicate through their owning
live Pi session.

## Verification

Unit tests cover comment grammar, tag combination, exact/ambiguous name
resolution, offline and failed delivery, deduplication/reload, and
recipient-only triage. Run `npm test`, `npm run check`, and `git diff
--check`. A live two-session Pi peer test remains necessary before
claiming end-to-end delivery; no credentials or terminal context are
assumed by unit tests.
