# Changelog

## Unreleased

- The release workflow uploads to ClawHub without waiting for ClawHub's security review, which once took longer than the 30-minute wait and failed a release that ClawHub later published. The upgrade procedure installs a version once ClawHub lists it.

## 2026.10.3 - 2026-10-10

- Chat rewrites work: the model call runs within the manager's turn that sent the message. In 2026.10.2 it ran in the board service's own context, which OpenClaw refuses once the service's start has finished ("Gateway is draining"), so every message went out as written. While the chat is busy or changes during the rewrite, that turn now waits and rewrites again, for up to two minutes. Messages the scan sends on its own (stall notices, retries) go out as written.
- In a project chat, a task waiting on the user is shown with the last message the user received for it (one with a delivery receipt) and any newer note, marked internal, instead of only the latest note. The note had made the product manager take his own question for a leaked internal note and ask it again.

## 2026.10.2 - 2026-10-09

- Messages to the project chat are rewritten for the conversation before they are sent. Messages are written in private task sessions that cannot see the chat, so a result arriving days later, or between other replies, could read as out of context. Before the first send, one tool-free model call as the product manager sees the chat since the request, the task and the message as written, together with his identity, character and notes about the user. It keeps the facts and adds only as much background as the user needs. Deliveries run one at a time, and while the chat is mid-reply, or changes during the rewrite, a message is rewritten again shortly, for up to two minutes. If the rewrite fails, the message goes out as written. The optional `rewriteModel` setting picks a different model for it (the entry then needs `subagent.allowModelOverride`); by default it uses the product manager's own model.
- `notify` from the project chat sends nothing, as `update_task` already did: the reply is the message.

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
