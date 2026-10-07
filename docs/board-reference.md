# Board reference

[Documentation home](index.md) · [Repository README](https://github.com/ag14774/openclaw-jarvis-gilfoyle/blob/main/README.md)

Detailed behavior of the `project_board` tool and its private task sessions. The bundled [project-coordination skill](https://github.com/ag14774/openclaw-jarvis-gilfoyle/blob/main/skills/project-coordination/SKILL.md) describes agent judgment and the working protocol; the rules below describe checks the plugin can enforce from callers, board rows and native calls.

## Board records

- **Projects:** name, free-text context (repositories, conventions), the chat for messages, and state (`active`, `paused`, `archived`).
- **Tasks:** title, body, status (`open`, `done`, `cancelled`) and a holder: whose turn it is (`product`, `engineering`, `user`).
- **Notes:** an append-only log per task. Handovers and closing always carry one.
- **Outbox:** messages to the user, optionally with files, delivered with native idempotency, retries and an owner-DM fallback.

## Tool operations

Both managers use one tool, `project_board`, with an `operation` and its fields. `project` is implied in a task session or project chat; `task` is implied in a task session.

| Operation        | What it does                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`           | Projects with open tasks, recently closed tasks and undelivered messages. Archived projects are omitted unless selected explicitly.                         |
| `show`           | One task with its notes, or one project with its context.                                                                                                   |
| `create_project` | Product only. Takes `name` and optional `context`; uses the chat of the current user message when available.                                                |
| `update_project` | `name`, `state` and `use_this_chat` (product only), or `context` (either manager).                                                                          |
| `add_task`       | `title`, optional `body` and `holder`. New tasks are held by engineering by default, or product; to ask the user first, add for product and then hand over. |
| `update_task`    | `note`, handover (`holder`), close or reopen (`status`), `message` with optional `attachments`, `check_in_minutes`.                                         |
| `notify`         | Product only. `message` to the user in the project chat, with optional `attachments`.                                                                       |

`check_in_minutes` accepts 1–10080; an update without it schedules the next check-in for 60 minutes. `attachments` travel with a message, not on their own.

## Scheduling and model choice

A mechanical scan (every 60 seconds by default) wakes whichever manager holds an open task in an active project, in that task's own private session. It wakes a manager when someone else changed the task or the check-in time is due. It never wakes anyone for the user and avoids interrupting a session reported as mid-turn. Each manager runs at most `maxWakesPerRole` private sessions at once.

OpenClaw's completion notice continues the holder's session when a worker ends, including one stopped by a restart; the check-in is the fallback. Failed dispatches keep the outstanding change and retry at the existing five-minute cadence without consuming inactivity allowance. Accepted dispatches count only if the task has not changed meanwhile; an ambiguous dispatch is checked against native session liveness before retry. After three accepted wakes without a task change and with no running workers, the scan reports the stall to the user once and stops automatic wakes for that task until an update resets it.

Both managers' private task sessions follow the model and thinking level selected in the project chat (`/model`, `/think`), read at every wake. Without a selection they use the agents' defaults. If copying the settings fails, the plugin logs it and proceeds. The source chat session is the one OpenClaw routed the binding message to; each later user message in that chat refreshes it if changed. Messages in other chats never change it. `/new` and `/reset` keep the session and choice.

## Enforcement

### Roles, handovers and lifecycle

- Only product creates or renames projects, pauses, resumes or archives them, binds chats, messages the user, hands tasks to the user, reopens tasks and closes tasks it created. Engineering may close only tasks it created. Both managers may update project context.
- Handing a task to the user or closing a product-created task requires a `message` in the same call. The message is queued in the same transaction as the change. In the project's own chat, the manager's reply is the message; `update_task` does not send it a second time, and files must be attached to that reply.
- Handovers and closing require a note. Closed tasks are read-only until product reopens them.
- Engineering hands over or closes only tasks it holds. A handover, close or reopen is refused if a newer note arrived since the calling session last read the task in this turn; reread with `show` and decide again. After asynchronous worker inspection, current task row facts and latest note identity are revalidated in the mutation transaction, so stale decisions cannot overwrite newer changes.
- A private task session sees and changes only its own project.
- A task cannot be marked `done` while its workers run. Cancelling aborts workers and clears their queued follow-ups. Scans retry recorded workers on cancelled tasks using `check_at` at five-minute intervals, inspecting at most ten oldest-due tasks per scan; late worker records schedule immediate inspection. Unknown native state is not confirmed termination. This inspection is separate from seven-day private-session cleanup.
- Pausing stops automatic wakes and new worker spawns, not existing workers. Resuming prompts the holders of open tasks to look again. Archiving requires all tasks to be closed or cancelled.
- Runs in closed-task private sessions are refused. Both managers' sessions are kept for seven days for review, then deleted once idle; reopening within that period can continue in the old sessions.

### Worker and messaging guards

- Workers spawned with `sessions_spawn` from a task session are recorded on that task.
- For the configured worker agent, use `model: "<profile id>"`. The plugin applies the profile's model, thinking level and configured runtime. A matching model/thinking pair is also accepted. Target `agentId` is trimmed as in native `sessions_spawn`, including for scoped admission failure handling. `worker.limit` counts currently observed configured workers launched directly by engineering from board task sessions, across all task/project statuses, even without a worker record. Native parent provenance identifies these launches; descendants and product/personal launches do not consume this limit. Native active rows count regardless of age, and recent recorded workers retain a two-minute visibility grace. Current native rows are read in 200-row pages, using native completeness/next-offset facts; an unreadable list, unknown completeness, nonadvancing pagination, unknown activity of an in-scope row, or an active/unknown row without parent provenance refuses admission. These reads are observations, not an atomic native snapshot. Recent records without native parent provenance also refuse during visibility grace. Older historical records do not require a native row to remain readable: history stays append-only, and a missing/deleted row is not confirmed physical termination.
- Registrations with equal JSON configuration values share one board-owned single-flight admission gate in a process, regardless of object property order (array order remains significant; `:memory:` registrations remain separate). The gate is claimed before counting and serializes count, launch and known-child recording until its matching `after_tool_call` completion hook or a fixed 16-minute expiry from claim acquisition. Expiry is checked lazily on admission, using process-local monotonic time so wall-clock rollback does not extend it; no scheduler or persistent reservation is involved. Reload or companion recovery preserves the original claim deadline. A concurrent caller before expiry is refused immediately with a retry instruction, without queuing or holding a SQLite transaction through native calls. Required native run/tool-call IDs must be present and consistent; the parent session key and any observed session ID must also match for release. Task/project lifecycle and worker records are rechecked after native reads, as are claim ownership and expiry before permission is returned. A delayed old prelaunch callback cannot grant or release a newer claim.
- Plugin prelaunch refusals release their own claim. Matching completion releases it even with an error, unknown, empty or missing result, after attempting to record any known child. Recording errors are logged but do not retain completed-call serialization. Worker identities remain append-only rather than truncated. A missing completion hook stops blocking the next admission at expiry; turn cancellation does not clear the claim. Unrelated or late hooks still record known children but cannot release a newer claim. Completion and expiry are not proof of no native effect; the native no-start receipt does not survive after-hook result cloning. Expiry may permit overlap with a slow or ambiguous invisible worker, so later launches may exceed the observational limit. The boundary is bounded same-process invocation ordering plus current native observations and recent-record grace, not effect custody or a hard capacity bound. Process restart loses unfinished-call serialization. Different configurations/path identities, bypassed hooks, native liveness projection, deleted/unobserved sessions, follow-ups and reactivation remain outside this boundary; there is no cross-process or restart-safe guarantee. Capacity waits continue to use ordinary task notes and existing check-ins.
- Spawns are refused for closed tasks and non-active projects. Profile and concurrency checks apply to the configured worker agent, not spawns targeting another agent.
- From task sessions, `sessions_send` may reach only that task's own workers by session key; the `message` tool is refused. Private task-session replies never intentionally go into user chats; board messages are the user-facing path.
- `use_this_chat` binds only the chat of the user message that started the current turn, never an arbitrary supplied destination.

### Delivery and chat history

- Messages go only to the project chat, or the configured owner DM when there is no bound chat, the project chat rejects them or it keeps failing. Owner-DM messages are prefixed with the project name. Delivery never rebinds the project's chat.
- Native idempotency keys keep retries from intentionally sending duplicates. Delivery has finite retries and can become failed; `list` and health expose undelivered messages and failures.
- Attachments are up to four existing files (absolute paths, 8 MB each). They follow the text as native message sends, each with a stable idempotency key, and are read again on every attempt. A failed file retries the whole message; idempotency protects text already sent. Files must remain available until delivery finishes.
- A delivered message is added as the product manager's own reply to the session for the chat it reached (project chat or owner DM): the text as sent, then one `MEDIA:` line per file. OpenClaw's transcript writer uses a stable idempotency key so the Control UI history and later model context reflect the delivered message.
- The existing receipt JSON preserves the attempted destination, native operation identity and exact text; accepted text and its remaining attachments stay at that destination across project rebinding or renaming. Future new messages still resolve the current binding. Transcript append waits while that destination session runs a turn and is retried by the scan for a day. Legacy receipts or partial attempts without a recoverable destination remain visibly uncertain rather than guessing from the current binding. An append failure is logged and never affects delivery.

### Scope and failure behavior

Outside the board tool and private task-session guards, the plugin adds only brief manager context: in other chats, one line explaining that the project role adds to the usual role; in a project chat, the product manager also sees the project name and tasks waiting on the user. Other agents and the product manager's personal-assistant work are otherwise unaffected.

Hook errors are normally logged and ignored. Configured-worker admission from engineering task sessions instead returns a scoped refusal on prelaunch errors or unknown current counts. Known-child recording failures are logged; matching completed invocations release their claim. Product/personal work, other agents and other tools do not wait on that claim. The board is not a security sandbox or a substitute for host tool permissions. An unavailable board is reported by the tool and health; scans log failures. The shared runtime and companion are replaced on plugin reload, or after the companion has not answered for five minutes, and scans try again using the persistent board; replacement preserves unfinished-call serialization and its original expiry.

## Configuration

Required configuration is shown in [getting started](getting-started.md#configure-the-plugin); the authoritative shape is [openclaw.plugin.json](https://github.com/ag14774/openclaw-jarvis-gilfoyle/blob/main/openclaw.plugin.json).

| Setting                                                  | Default / constraint                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `statePath`                                              | Required absolute path to a new file or schema 18 board. No automatic migration. `:memory:` is accepted for ephemeral use. |
| `productAgentId`, `engineeringAgentId`, `worker.agentId` | Required, distinct OpenClaw agent IDs.                                                                                     |
| `ownerChat`                                              | Required `channel`, `accountId`, `to`; optional `threadId`. The owner's direct chat with product, used for fallback.       |
| `worker.profiles`                                        | Required, 1–8 profiles with `id` and `model`; optional `thinking` and `description`.                                       |
| `worker.runtime`                                         | `acp`; also accepts `subagent`.                                                                                            |
| `worker.limit`                                           | 2; range 1–20; engineering's directly launched configured workers.                                                         |
| `sessionNamespace`                                       | `jarvis-gilfoyle`.                                                                                                         |
| `scanMs`                                                 | 60000; range 10000–600000.                                                                                                 |
| `turnTimeoutSeconds`                                     | 1800; range 60–14400, for each private task-session turn.                                                                  |
| `maxWakesPerRole`                                        | 2; range 1–10.                                                                                                             |
| `enabled`                                                | Omitted means enabled; `false` stops automatic scans/wakes. This config flag does not remove the board tool.               |

The entry's `enabled` switch and hook permissions are OpenClaw settings, separate from the plugin's `config.enabled`. Managers need `project_board` permission; their other tools and worker runtime remain host configuration.

SQLite uses WAL, full synchronous writes and foreign keys. New parent directories use mode `0700`, and the database file is set to `0600`. The store accepts an empty schema-zero database or schema 18; nonempty schema-zero files and other versions are refused before board DDL, chmod or journal changes. Version 18 is not a comprehensive database-identity check, so always use a dedicated board file, never an unrelated database. See [backup and staged recovery](recovery.md) for the standalone operator utility and its separate verification boundary.

## Operator methods

| Gateway method                 | Parameters / access                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `jarvis-gilfoyle.board.call`   | `{operation, input, agentId?, sessionKey?}`; defaults to product and an operator session. Requires `operator.admin`.                          |
| `jarvis-gilfoyle.board.tick`   | Runs a scan. Requires `operator.admin`.                                                                                                       |
| `jarvis-gilfoyle.board.health` | Reports enabled/registry state, scan health and counts of projects, open/stalled tasks and pending/failed messages. Requires `operator.read`. |

See [TESTING.md](https://github.com/ag14774/openclaw-jarvis-gilfoyle/blob/main/TESTING.md) for checks and live-integration limitations, and the [changelog](https://github.com/ag14774/openclaw-jarvis-gilfoyle/blob/main/CHANGELOG.md) for historical schema changes.
