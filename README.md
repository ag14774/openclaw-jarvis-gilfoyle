# OpenClaw Jarvis-Gilfoyle

<p align="center">
  <img src="docs/assets/logo.png" width="600" alt="Pixel-art Jarvis robot and long-haired Gilfoyle android engineer flanking a coral claw" />
</p>

A small, personal-use OpenClaw plugin for coordinating a product-manager agent and an engineering-manager agent. A shared SQLite board tracks requests, handovers and messages; private task sessions let the managers follow up and delegate work.

```text
user <-> product manager (Jarvis) <-> project board <-> engineering manager (Gilfoyle) -> workers
```

The names are thematic; roles map to your configured agent IDs. This repository is private and the package is `UNLICENSED`.

[Releases](https://github.com/ag14774/openclaw-jarvis-gilfoyle/releases) · [CI](https://github.com/ag14774/openclaw-jarvis-gilfoyle/actions/workflows/ci.yml) · [Board reference](docs/board-reference.md) · [Changelog](CHANGELOG.md)

## Quick setup

Use **OpenClaw `2026.9.8`** and Node.js with `node:sqlite`: `>=24.16.0 <25 || >=26.1.0` (CI uses `26.8.1`). Run these commands from a local checkout you have access to:

```bash
npm ci
npm run build
openclaw plugins install --link . --force --accept-capabilities
```

Add the following entry to your OpenClaw configuration. Replace the database path, agent IDs, owner DM and worker model with your own values. The three agent IDs must be distinct and refer to agents you have configured; the model must be available to your worker.

```json
{
  "plugins": {
    "entries": {
      "jarvis-gilfoyle": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true, "allowPromptInjection": true },
        "config": {
          "statePath": "/absolute/path/to/board.sqlite",
          "productAgentId": "main",
          "engineeringAgentId": "gilfoyle",
          "ownerChat": {
            "channel": "telegram",
            "accountId": "default",
            "to": "telegram:123456789"
          },
          "worker": {
            "agentId": "opencode",
            "runtime": "acp",
            "limit": 2,
            "profiles": [
              {
                "id": "sol-low",
                "model": "openai/gpt-5.6-sol",
                "thinking": "low",
                "description": "Routine work."
              }
            ]
          }
        }
      }
    }
  }
}
```

Grant `project_board` to both managers in their tool permissions, and make the bundled [project-coordination skill](skills/project-coordination/SKILL.md) available to them. For `runtime: "acp"`, configure the worker's ACP runtime in OpenClaw; `"subagent"` is also supported.

Use a new database file or an existing **schema 18** board at `statePath`; there is no automatic migration. Do not point it at an unrelated database. Then restart the Gateway:

```bash
openclaw gateway restart
```

A linked install loads `dist/` at Gateway startup. After source changes, rebuild and restart. Optional scan, timeout and concurrency settings are in the [configuration reference](docs/board-reference.md#configuration).

## Everyday workflow

1. **Start in the project chat.** Ask the product manager to create a project and record its context. The board binds messages to that chat.
2. **Request work.** Product adds a task, held by engineering by default. Engineering works in the task's private session, delegates to workers and hands the result back with a note.
3. **Answer questions in the chat.** Product hands the same task to the user with a message when input is needed, then passes the answer back to engineering.
4. **Review and finish.** Product checks the result, closes the task and tells you what changed. Progress updates use `notify`; handovers and closing require notes.

The board scans every **60 seconds** by default. It wakes the manager holding a changed task or a due check-in (normally **60 minutes**), without interrupting an active turn. Tasks held by the user get no automatic wake-ups. Set `/model` and `/think` in the project chat to choose settings for both managers' private task sessions; otherwise their agent defaults apply.

See the [board reference](docs/board-reference.md) for all seven `project_board` operations, scheduling, delivery and operator methods.

## Safety and limitations

- **Role and project checks:** only product controls project names, lifecycle, chat binding and user messages. Private task sessions are scoped to their own project; stale handover decisions must reread the task.
- **Worker lifecycle:** configured worker profiles and a shared worker limit govern delegation from task sessions. Running workers prevent `done`; cancellation aborts them. Paused projects get no automatic wakes or new workers, but pausing does not abort existing workers.
- **User delivery:** board messages use the project chat, with retries and a configured owner-DM fallback. Attachments are up to four existing absolute-path files, 8 MB each, read again on each attempt. Delivery can still fail; inspect board/health output rather than assuming receipt.
- **Private is a session role, not a sandbox:** task-session replies are suppressed from user chats, but hooks fail open (errors are logged and ignored). These guards do not replace OpenClaw tool permissions or worker isolation; agent judgment is guided by the skill.
- **Storage and retention:** the SQLite board survives restarts. Closed-task private sessions are kept for seven days, then removed once idle. Keep the board and transcripts in your trusted local environment.

The [full enforcement and delivery rules](docs/board-reference.md#enforcement) include required messages, chat-binding restrictions, transcript recording and the scope of worker guards. [Testing limitations](TESTING.md#native-integration) cover live models, real channels and real-Gateway cleanup.

## Development

```bash
npm ci
npm run format:check
npm run check
npm test
npm run pack:check
```

[TESTING.md](TESTING.md) describes behavioral and native checks. [CI](.github/workflows/ci.yml) runs the checks above; its optional native job runs on manual dispatch. See the [plugin schema](openclaw.plugin.json), [source](src/index.ts), [coordination skill](skills/project-coordination/SKILL.md) and [changelog](CHANGELOG.md) for implementation details and changes.
