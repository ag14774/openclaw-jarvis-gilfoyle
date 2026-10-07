<p align="center">
  <img src="docs/assets/logo.png" width="600" alt="Pixel-art Jarvis robot and long-haired Gilfoyle android engineer flanking a coral claw" />
</p>

<h1 align="center">OpenClaw Jarvis-Gilfoyle</h1>

<p align="center">Two manager agents, one shared board, clear handovers.</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/OpenClaw-2026.9.8-ef6b57" alt="OpenClaw compatibility: 2026.9.8" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D24.16.0%20%3C25%20%7C%7C%20%3E%3D26.1.0-43853d" alt="Node.js requirement: >=24.16.0 <25 or >=26.1.0" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Repository-private-6b7280" alt="Private repository" /></a>
</p>

<p align="center">
  <a href="#quick-setup">Setup</a> · <a href="#everyday-workflow">Usage</a> · <a href="#safety-and-limitations">Safety</a> · <a href="docs/board-reference.md">Board reference</a> · <a href="#development">Development</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

A small, personal-use OpenClaw plugin that coordinates a product manager (Jarvis) and an engineering manager (Gilfoyle). A shared SQLite board keeps projects, tasks, notes and user messages; private task sessions let the managers follow up and delegate to workers.

You talk to product in the project chat. Product records the request, engineering does the work, and product brings back results or questions. The names are thematic: roles map to your configured agent IDs. **This repository is private; the package is `UNLICENSED`.**

## Quick setup

Use **OpenClaw `2026.9.8`** and Node.js with `node:sqlite`: **`>=24.16.0 <25 || >=26.1.0`** ([CI](.github/workflows/ci.yml) uses `26.8.1`). From a local checkout you have access to:

```bash
npm ci
npm run build
openclaw plugins install --link . --force --accept-capabilities
```

Add a `jarvis-gilfoyle` entry to your OpenClaw configuration. Replace the database path, agent IDs, owner DM and worker model below. All three agent IDs must be distinct and configured; the model must be available to your worker.

<details>
<summary>Required configuration example</summary>

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

</details>

- **Permissions:** grant `project_board` to both managers and make the [coordination skill](skills/project-coordination/SKILL.md) available to them. Enable both hook permissions shown above: `allowConversationAccess` and `allowPromptInjection`.
- **Workers:** configure the worker's ACP runtime in OpenClaw for `runtime: "acp"`; `"subagent"` is also supported.
- **Storage:** use a dedicated new SQLite file or an existing **schema 18** board at the absolute `statePath`. There is **no automatic migration**; never use an unrelated database.

Restart the Gateway to load the plugin:

```bash
openclaw gateway restart
```

A linked install loads `dist/` at Gateway startup; **rebuild and restart after source changes**. See the [configuration reference](docs/board-reference.md#configuration) for optional settings and [plugin schema](openclaw.plugin.json) for the authoritative shape.

## Everyday workflow

1. **Start in the project chat.** Ask product to create a project and record its context; messages are bound to that chat.
2. **Request work.** Product adds a task for engineering, which works in a private task session, delegates to workers and hands back a result with a note.
3. **Answer and review.** Product brings questions to you in the chat, passes answers back, then checks the result, closes the task and tells you what changed.

By default, the board scans every **60 seconds** for changed tasks or due check-ins (normally **60 minutes**). It wakes the holding manager without interrupting an active turn; user-held tasks get no automatic wakes. Use `/model` and `/think` in the project chat to choose settings for both managers' private task sessions; otherwise agent defaults apply.

The [board reference](docs/board-reference.md) covers all seven `project_board` operations, handover rules, scheduling, delivery and operator methods.

## Safety and limitations

- **Trusted host, not a sandbox.** Private task-session replies are suppressed from user chats, but **hooks fail open**: errors are logged and ignored. Keep OpenClaw tool permissions and worker isolation in place; keep the board, transcripts and attachment files on a trusted host.
- **Scoped coordination.** Only product controls project lifecycle, chat binding and user messages. Private task sessions are scoped to their project; stale handovers require a reread. The plugin does not constrain other agents or product's personal-assistant work.
- **Workers and pauses.** Running workers prevent `done`; cancellation aborts them. Pausing stops automatic wakes and new workers, but does not abort existing workers. Profile and shared-limit guards apply to the configured worker agent.
- **Delivery and retention.** Messages retry to the project chat with an owner-DM fallback, but can still fail: check board/health output for undelivered messages. Attachment files must remain available until delivery finishes. SQLite survives restarts; closed-task private sessions are kept for seven days, then removed once idle.

See [enforcement and delivery rules](docs/board-reference.md#enforcement) for exact boundaries and [testing limitations](TESTING.md#native-integration) for live models, real channels and real-Gateway cleanup.

For consistent private board snapshots and safe staged verification, see [backup and recovery](docs/recovery.md). The operator utility never replaces the live board.

## Development

```bash
npm ci
npm run format:check
npm run check
npm test
npm run pack:check
```

[TESTING.md](TESTING.md) explains the checks and their side effects. [CI](.github/workflows/ci.yml) runs the checks above; native integration is optional on manual dispatch. Browse the [source](src/index.ts), [coordination skill](skills/project-coordination/SKILL.md) and [changelog](CHANGELOG.md) for implementation details and changes.
