# File-in handoffs

Pi sessions loaded with pi-wrk register a private mailbox and a live FIFO
under the project's `.agents/pi/file-in/handles/`. Name the session
(`/name arc-cleanup`), then run `/wrk inbox` for its return paths. Ask an
agent for that address before sending it a reply. `general` addresses
broadcast to sessions live when the helper submits the message or the
worker receives a pipe/legacy write.

From the project root, use the durable helper:

```sh
./pi-wrk/bin/send-to-pi.mjs --list
./pi-wrk/bin/send-to-pi.mjs /absolute/path/from/wrk/inbox < message.md
./pi-wrk/bin/send-to-pi.mjs general < announcement.md
```

The helper accepts either the mailbox or FIFO path as its destination;
both choices **write an atomic mailbox file**. Named mailbox messages remain
available through a Pi reload or an offline session until it reopens the
same session ID. Broadcast goes only to live sessions, never future ones.

For a live pipe, direct shell redirection also works:

```sh
cat message.md > /absolute/path/from/wrk/inbox.fifo
cat announcement.md > /absolute/path/to/handles/general.fifo
```

Messages are limited to 1 MiB. Direct FIFO writes can block while the
worker is down. Use one writer at a
time: POSIX FIFOs cannot frame simultaneous raw Markdown writers, so their
messages can combine. Use the helper when durability or concurrent writers
matter. The worker owns FIFO readers, including the broadcast reader.

The recovered CIPR inbox path still works: files written directly to
`.agents/pi/file-in/` are treated as `general` handoffs after a 250 ms quiet period. The worker
archives those files in `processed/` or `failed/`. Named mail is archived
under each handle's `processed/` or `failed/` after Pi accepts the
message. This records submission to Pi, **not** completion of the agent's
turn. A crash between submission and archiving can replay one message.
Incoming file contents are marked as untrusted, not as approval.

No issue, model, or infrastructure job is started by file-in registration.
Use disposable files to verify routing before relying on it operationally.
