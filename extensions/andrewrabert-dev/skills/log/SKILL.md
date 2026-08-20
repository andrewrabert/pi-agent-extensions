---
name: log
description: Use when explicitly asked to journal or log the conversation (e.g. /skill:log) — capture an immutable, timestamped entry via noted_log_note.
---

# log

Journal about the current conversation using `noted_log_note`.
Invoke this only when explicitly asked (e.g. `/skill:log <focus>`); never start it
on your own.

`noted_log_note` writes an immutable, timestamped entry — its metadata is
auto-generated and it cannot be edited or deleted afterward. Write the log to
stand on its own: enough context that a future reader understands what happened
without the surrounding conversation.

If a focus is given, center the entry on it; otherwise summarize the salient
decisions, changes, and open threads from the conversation.
