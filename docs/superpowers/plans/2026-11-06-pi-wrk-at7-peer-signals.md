# Agent-addressed @@7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route addressed @@7 source comments to one named live Pi peer without changing unaddressed intake.

**Architecture:** Parse optional address/claim/author tags in work-file comments. An optional adapter to pi-intercom's existing extension bus relays addressed comments and acknowledgements; receiver admits them to its own existing @@7 triage on its next turn. Persist pending outbound/inbound keys through Pi session entries so reloads and retries do not falsely claim delivery.

**Tech Stack:** TypeScript Pi extension, node:test, optional `intercom:extension-register` event bus (no hard runtime dependency).

**Spec:** `docs/superpowers/specs/2026-11-06-pi-wrk-at7-peer-signals.md`

## Global Constraints

- `@@7:@id` addresses a Pi agent identity, never a Zellij tab.
- `@@7::id` is advisory claim; `@@7:+id` is untrusted author metadata. Neither grants permission.
- Only valid source-file comment lines relay; existing plain @@7 and terminal intake remain unchanged.
- No edits to sender's dirty worktree from the recipient; peer channel may be absent.
- No guaranteed delivery until recipient confirms admission; no live-auth claims from unit tests.

## Review Focus

- Ambiguous peer name: fail closed, never pick one arbitrarily (Task 2 test).
- No intercom extension or disconnected bus: leave pending and warn without blocking plain intake (Task 3 test).
- Sender commits the comment before acknowledgement: pending entry survives reload (Task 3 test).
- Spoofed `+`/`::` text: preserve as advisory metadata, never trust as transport identity (Tasks 1, 3 tests).
- Duplicate peer event or owner reload: one recipient triage admission, one acknowledgement (Task 3 test).

### Task 1: Parse comment roles

**Files:** Modify `extensions/at7-files.ts`; test `tests/at7-files.test.mjs`.

**Interfaces:** Extend `At7Message` with optional `recipient`, `claimedBy`, `author`. `message(source, location, line)` continues to return `key` keyed to full comment text/source/location; reject an empty addressed message and malformed identifiers. Permit exact Pi names containing `#`, `.`, `_`, `-` or UUIDs; reject `:` tab addresses. Keep terminal `@@7 text` parsing unchanged.

- [ ] Add failing tests: one line `// @@7:@BEACON @@7:+writer @@7::BEACON check` extracts all roles and `text='check'`; plain `// @@7 check` unchanged; `// @@7:@sensible-yak:term check` and bare `// @@7:@BEACON` ignored; terminal `@@7 hello` unchanged.
- [ ] Run `node --test tests/at7-files.test.mjs` and observe failure.
- [ ] Implement tag parsing as one small function, retaining current changed-line collection and dedup behavior.
- [ ] Re-run targeted test; commit parser/test.

### Task 2: Connect optional live peer channel

**Files:** Create `extensions/at7-peers.ts`; test `tests/at7-peers.test.mjs`.

**Interfaces:** `createAt7PeerRelay(pi, identity: () => string | undefined, handlers: { onSignal(signal): void; onAck(ack): void })` registers namespace `pi-wrk-at7` through `intercom:extension-register` and `intercom:extension-registry-ready`. It exposes `send(item, source): Promise<'offered'|'unavailable'|'unknown'|'ambiguous'>` and `ack(signal): void`. An envelope contains a deterministic key (`senderSessionId` + comment key), exact target session ID, sender session ID, source path/text/tags. `send` resolves names against `channel.listSessions()`; UUIDs may match session ID. Publish to `audience:'capable'`; receivers filter target against `PI_INTERCOM_SESSION_ID`, use the authenticated `fromSessionId` on the event rather than trusting a payload sender, and only accept ACKs from the resolved recipient. Never mistake publication for acknowledgement. No hard import of pi-intercom.

- [ ] Add failing tests using fake Pi event bus/channel: exact name and UUID resolution, ambiguous and absent names, disconnected channel, receiver filtering, matching ack only, extension loading in either order.
- [ ] Run `node --test tests/at7-peers.test.mjs` and observe failure.
- [ ] Implement adapter; run targeted test; commit adapter/test.

### Task 3: Wire durable relay to existing triage

**Files:** Modify `extensions/index.ts`; test `tests/extension.test.mjs`.

**Interfaces:** Keep addressed comments out of local `scanAt7` admission. Persist outbound pending keys with their full comment envelope in `wrk-at7-peer-outbox`; mark delivered only on matching recipient ack. Queue inbound signals in `wrk-at7-peer-inbox` on receipt, then on next owner turn admit them through the existing isolated triage path using the *recipient's* root, reusing `seen`/journal for one admission per sender/key; acknowledge only after admission or already-admitted dedupe. Rebuild both journals at `session_start`; retry pending outbound on later owner turns. Sender root/path in remote payload is lower-trust context, never recipient workspace authority. If channel/peer is unavailable, warn once per key rather than dropping or locally executing the message.

- [ ] Add failing host-free tests: `@other` does not create local job; peer inbox admitted once on next turn with owner dirty files untouched; ack confirms sender delivery; reconnect/reload retries pending but never duplicates admitted work; offline peer remains pending; unaddressed and terminal behavior unchanged.
- [ ] Run `node --test tests/extension.test.mjs` and observe failure.
- [ ] Implement minimum integration, run targeted test; commit integration/test.

### Task 4: Document and verify

**Files:** Update `README.md` with syntax, agent identity vs tab address, advisory claim/author, optional channel/offline behavior, and live road-test instructions. Do not change `/watch:zellij`.

- [ ] Run `npm test`, `npm run check`, and `git diff --check` on the feature worktree; fix failures before claiming completion.
- [ ] Verify syntax examples by parsing a valid comment directly and document that zsh inline `#@@7` is not reliably a comment.
- [ ] Commit docs. Report inability to assert authenticated two-session behavior until an operator performs a live road test.
