# OpenClaw Jarvis-Gilfoyle

An OpenClaw plugin that gives a product-manager agent and an engineering-manager agent a small shared project board in SQLite:

```text
user <-> product manager (Jarvis) <-> project board <-> engineering manager (Gilfoyle) -> workers
```

The names are thematic; roles map to configured OpenClaw agent IDs.

## The board

- **Projects**: name, free-text context (repositories, conventions), the chat its messages go to, and a state (`active`, `paused`, `archived`).
- **Tasks**: title, body, status (`open`, `done`, `cancelled`) and a **holder**: whose turn it is (`product`, `engineering` or `user`).
- **Notes**: an append-only log per task. Handovers and closing always carry one.
- **Outbox**: messages to the user, delivered with native idempotency, retries and an owner-DM fallback.

A mechanical scan (every 60 seconds by default) wakes whichever manager holds a task, in that task's own private session. It wakes a manager when someone else changed the task, or when the task's check-in time is due (60 minutes, or the holder's `check_in_minutes`). It never wakes anyone for the user, and never interrupts a session that is mid-turn. Each manager runs at most `maxWakesPerRole` private sessions at once. A holder woken three times without changing the task makes the plugin tell the user once; any change resets this.

Private task sessions of both managers run on the model and thinking level the user chose in the project chat (`/model`, `/think`), read at every wake. Without such a choice they use the agents' defaults. The project chat's session is the one OpenClaw routed the binding message to, and every later user message in that chat records it again if it changed; messages in other chats never change it. `/new` and `/reset` keep both the session and the choice.

## Tool

One tool, `project_board`, for both managers:

| Operation        | What it does                                                                            |
| ---------------- | --------------------------------------------------------------------------------------- |
| `list`           | Projects with their open tasks, recently closed tasks and undelivered messages.         |
| `show`           | One task with its notes, or one project with its context.                               |
| `create_project` | Product only. Uses the chat of the current user message.                                |
| `update_project` | Name, `state` and `use_this_chat` (product only), or `context` (either manager).        |
| `add_task`       | New task, held by engineering unless `holder` says otherwise.                           |
| `update_task`    | `note`, handover (`holder`), close or reopen (`status`), `message`, `check_in_minutes`. |
| `notify`         | Product only. Message the user in the project chat.                                     |

## What the plugin enforces

Rules are enforced when they can be checked from the caller, the rows that already exist, or a native call the plugin already makes. Everything else is agent judgment, described in the bundled `project-coordination` skill.

- Only the product manager creates or renames projects, pauses, resumes or archives them, binds chats, messages the user, hands tasks to the user, reopens tasks and closes tasks it created. The engineering manager may close only tasks it created.
- Handing a task to the user, or closing a product task, requires the `message` for the user in the same call. The message is queued in the same transaction as the change. The exception is a call made from the project's own chat, where the manager's reply is the message and a `message` is not sent a second time.
- Handovers and closing require a note. Closed tasks are read-only until reopened.
- The engineering manager hands over or closes only tasks it holds. A handover or close is refused when a newer note arrived since the calling session last read the task in this turn; it reads the task again and decides.
- A private task session sees and changes only its own project.
- Workers spawned with `sessions_spawn` from a task session are recorded on that task. A spawn of the configured worker agent must name a worker profile (`model: "<profile id>"`); the plugin applies that profile's model, thinking level and runtime, and enforces `worker.limit`. Spawns are refused for closed tasks and paused projects. `sessions_send` may only reach the task's own workers, and the `message` tool is refused in task sessions.
- A task cannot be marked done while its workers run. Cancelling a task aborts them.
- `use_this_chat` binds only the chat of the message that started the current turn.
- Messages go only to the project chat, or to the configured owner DM (prefixed with the project name) when the project chat rejects them or keeps failing. The project's chat is never rebound by delivery.
- Private task sessions never reply into user chats. Runs in sessions of closed tasks are refused, and those sessions are deleted once idle.

Outside the tool and private task sessions the plugin does nothing. It adds no context to personal chats, and it leaves other agents and the product manager's personal-assistant work untouched. In a chat that is a project chat, the product manager gets one line naming the project and one line per task waiting on the user. Hooks fail open: any hook error is logged and ignored.

## Installation

```bash
npm ci
npm run build
openclaw plugins install --link . --force --accept-capabilities
openclaw gateway restart
```

A linked install loads `dist/` when the Gateway starts. After changing source, run `npm run build` and restart the Gateway.

## Configuration

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

Optional settings: `sessionNamespace` (default `jarvis-gilfoyle`), `scanMs` (60000), `turnTimeoutSeconds` (1800), `maxWakesPerRole` (2) and `enabled`.

Grant `project_board` to both managers. `statePath` must be a new file or an existing board (schema 16); any other database is refused.

Operator gateway methods: `jarvis-gilfoyle.board.call` (`{operation, input, agentId?}`), `jarvis-gilfoyle.board.tick` and `jarvis-gilfoyle.board.health`.

## Development

Requires Node.js with `node:sqlite` and OpenClaw `2026.9.2`.

```bash
npm ci
npm run format:check
npm run check
npm test
```

See `TESTING.md`.
