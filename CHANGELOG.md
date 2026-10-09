# Changelog

## 2026.10.1 - 2026-10-09

- Coordination skill (protocol 11.16): product describes what the user needs, why, and what they would check, adding context but not requirements the user did not ask for, and keeps the bar in proportion to the request. Engineering asks for a design second opinion only for decisions that would be expensive to change later, not for self-contained changes that are easy to replace.
- Board backups work with a board of any schema version: the backup script checks that the file is a board and intact, and copies everything else as it is. Any version of the script can back up the board before an upgrade.

## 2026.10.0 - 2026-10-08

First public release. Earlier development versions were used only on the author's own host; their history is in git.

- A shared SQLite project board (schema 19) for a product manager agent and an engineering manager agent: projects with a chat and free-text context, tasks with a holder (whose turn it is), a working plan and notes, and messages to the user.
- Wake-ups: a scan wakes the holder of a changed task, or of a task whose check-in is due, in that task's private session. A holder woken three times without changing anything is reported to the user once.
- Delivery: messages go to the project chat with retries under one native operation identity, fall back to the owner DM, carry attached files, and are added to the chat's session as the product manager's reply.
- Workers: engineering launches configured worker profiles from task sessions; the board records them, applies the profile, enforces `worker.limit` and stops a cancelled task's workers.
- Bundled skills: `project-coordination` (how both managers run projects: splitting requests, design, plans, parallel steps, merging on current main, plain notes) and `code-review` (the repository's rules first, findings rated by likelihood and cost where the code runs, smallest fixes, size, a short report with a verdict).
- `scripts/board-backup.mjs` for consistent private board snapshots and staged verification.
- Releases are published from version tags as GitHub releases and on ClawHub: `openclaw plugins install clawhub:openclaw-jarvis-gilfoyle@<version>`.
