# Operations and troubleshooting

## Inspect health

Use the existing Gateway method **`jarvis-gilfoyle.board.health`** through an authenticated OpenClaw operator client. It requires `operator.read` and reports enabled/registry state, `lastScan`, `lastError`, and counts of projects, open/stalled tasks and pending/failed messages.

Ask a manager to use `project_board list` for the board overview and `show` for a task's notes. Counts and a recent scan help diagnose coordination; they do not establish real-channel receipt or successful engineering output.

Administrative methods **`jarvis-gilfoyle.board.call`** and **`jarvis-gilfoyle.board.tick`** require `operator.admin`. A manual tick is not read-only: it can deliver messages, wake managers and clean eligible closed sessions. See [operator methods](board-reference.md#operator-methods) before using it.

## When work stops

| Symptom                          | Inspect and next step                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board unavailable                | Check the reported `statePath` error, absolute path, host access and schema compatibility. Do not replace or migrate data by guesswork.                                         |
| Task is quiet                    | Check holder, project state, next check-in, live turn/worker state and stall notes. User-held tasks are intentionally not woken; paused projects are not scanned for wakes.     |
| Task is stalled                  | Read the latest notes and determine what is blocking it. A meaningful task update resets the stall; repeating a private reply without changing the task does not make progress. |
| Handover refused as stale        | Use `show` again in the current turn, read the newer note and decide again.                                                                                                     |
| Worker cannot start              | Check active/open state, configured agent/profile/runtime and the shared worker limit. Host runtime availability and tool permissions remain external.                          |
| Task cannot be marked done       | Its workers must finish first. Pausing a project does not stop them.                                                                                                            |
| Scan cannot see manager sessions | Inspect `lastError` and Gateway/plugin logs for companion/session failures. An unseen session is not evidence it is idle.                                                       |

The shared runtime and companion are replaced on plugin reload, or after the companion has given no answer for **five minutes**. Subsequent scans retry against the persistent board. This mechanism does not promise a five-minute end-to-end recovery time or replace monitoring of health and logs.

OpenClaw's completion notice normally continues the holder's session when a worker ends, including one stopped by a restart; the scheduled check-in is the fallback. Do not assume a Gateway restart preserves a worker's execution.

## Missing messages or attachments

Inspect pending/failed outbox state with `list` and health, then check the native channel and owner-DM route. Messages use the project chat, falling back to the owner DM when absent, rejected or persistently failing. Fallback never rebinds the project.

Keep attachment paths available and readable until delivery finishes. A failed file retries the message using stable native identities for already-sent parts. Transcript recording is separate: it waits while the chat session is active and is retried by the scan for a day. Its failure is logged without changing delivery status.

Do not equate a queued message, a model's summary or a transcript entry with the user having read it.

## Maintenance and evidence

For a linked install, build source changes and restart the Gateway as described in [getting started](getting-started.md#load-and-check). Coordinate disruptive host actions with active work. Automatic closed-task cleanup keeps manager sessions for seven days and removes them only once idle; it does not erase the board's task records.

The repository's [testing guide](https://github.com/ag14774/openclaw-jarvis-gilfoyle/blob/main/TESTING.md) distinguishes local behavioral tests from native integration and live channel/model checks. Read its side effects before running operator or native checks. This documentation site's build validates documentation, not plugin reliability or live delivery.

Use the authoritative [backup and staged recovery guide](recovery.md) for consistent private snapshots and separate restore verification. Staging does not authorize replacement of a live board or establish full-host recovery.
