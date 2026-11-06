# pi-wrk readable work-item names

Status: self-approved at the user's request (2026-11-01).

## Intent

Give pi-wrk jobs short, unique names that humans can use while keeping UUIDs as durable internal identities. An unnamed worker agent handling a job inherits the job's name. This applies only to pi-wrk, not unrelated Pi Agent tool sessions.

## Behavior

- Use `docs/sorted_short_words.csv` as the word source. Pick a random row whose part of speech contains `Verb`, another containing `Noun`, and a digit `0`–`9`; produce lowercase `{verb}.{noun}.{digit}`. Exclude articles, pronouns, or malformed rows, and deduplicate words. The CSV currently exists only untracked in the pi-wrk main checkout; add it to this feature's branch deliberately.
- Load the CSV when the TypeScript extension loads; expose a tested name-generation function. The detached JS worker must use the same word selection rules for child jobs. Do not mistake an agent definition selector (`a:{name: ari}`) for a job's display label.
- Admission claims a name collision-safely for every root and child work item in the project store, across simultaneous sessions and restarts. Collision tries another candidate; exhaustion fails visibly instead of reusing a label. Store names alongside UUID jobs, not instead of them. Legacy jobs without labels remain inspectable by UUID.
- Provide a read-only registry of active pi-wrk jobs keyed by name, and accept a name or UUID for `/wrk status`, `output`, and `cancel`. Completed jobs remain accessible by UUID. Replies, notices and job listings show names alongside UUIDs. Worker agents inherit their work item's name in worker-owned metadata/identity while an explicitly selected agent definition still controls behavior.

## Alternatives

1. **Shared generator + durable collision claim (selected):** extension loads the words at startup, worker reuses the same parser for child jobs; store atomically reserves names. Names survive restarts and can resolve without changing UUID contracts.
2. **In-memory extension map:** simplest, but collides across sessions and disappears on reload; fails active registry requirement.
3. **Replace UUID keys with names:** terse storage paths but changes cancellation, references, and legacy data; unnecessary risk.

## Exclusions

Do not rename existing jobs or agent definitions; do not rewrite unrelated Pi agent sessions. A label is not permission to access another user's job; existing local-store access policy still governs. Test parser behavior, collision handling, child inheritance and active lookup; verify packaging includes the CSV. No infrastructure changes.
