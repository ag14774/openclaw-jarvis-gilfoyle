<p align="center">
  <img src="https://ageorgiou.com/openclaw-jarvis-gilfoyle/assets/logo.png" width="600" alt="Pixel-art Jarvis robot and long-haired Gilfoyle android engineer flanking a coral claw" />
</p>

<h1 align="center">OpenClaw Jarvis-Gilfoyle</h1>

<p align="center">Two manager agents, one shared board, clear handovers.</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/OpenClaw-2026.9.8-ef6b57" alt="OpenClaw compatibility: 2026.9.8" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D24.16.0%20%3C25%20%7C%7C%20%3E%3D26.1.0-43853d" alt="Node.js requirement: >=24.16.0 <25 or >=26.1.0" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-6b7280" alt="License: MIT" /></a>
</p>

<p align="center">
  <a href="https://ageorgiou.com/openclaw-jarvis-gilfoyle/">Documentation</a> · <a href="#quick-setup">Setup</a> · <a href="#everyday-workflow">Usage</a> · <a href="#safety-and-limitations">Safety</a> · <a href="https://ageorgiou.com/openclaw-jarvis-gilfoyle/board-reference/">Board reference</a> · <a href="#development">Development</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

A small, personal-use OpenClaw plugin that coordinates a product manager (Jarvis) and an engineering manager (Gilfoyle). A shared SQLite board keeps projects, tasks, notes and user messages; private task sessions let the managers follow up and delegate to workers.

You talk to product in the project chat. Product records the request, engineering does the work, and product brings back results or questions. The names are thematic: roles map to your configured agent IDs.

## Quick setup

Use **OpenClaw `2026.9.8`** and Node.js with `node:sqlite`: **`>=24.16.0 <25 || >=26.1.0`** ([CI](https://github.com/ag14774/openclaw-jarvis-gilfoyle/blob/main/.github/workflows/ci.yml) uses `26.8.1`). Install a pinned release from ClawHub; the [releases](https://github.com/ag14774/openclaw-jarvis-gilfoyle/releases) list the versions:

```bash
openclaw plugins install clawhub:openclaw-jarvis-gilfoyle@<version> --accept-capabilities
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

- **Permissions:** grant `project_board` to both managers. The bundled skills, [project coordination](skills/project-coordination/SKILL.md) and [code review](skills/code-review/SKILL.md), load for OpenClaw agents with the plugin; add them to any per-agent skill allowlist. To let workers find the code-review skill themselves as well, install it in their skill folder, for example with `npx skills add ag14774/openclaw-jarvis-gilfoyle --skill code-review -g`; it is optional, because engineering copies the review rules into each review brief. Enable both hook permissions shown above: `allowConversationAccess` and `allowPromptInjection`.
- **Workers:** configure the worker's ACP runtime in OpenClaw for `runtime: "acp"`; `"subagent"` is also supported.
- **Storage:** use a dedicated new SQLite file or an existing **schema 19** board at the absolute `statePath`. There is **no automatic migration**; never use an unrelated database.

Restart the Gateway to load the plugin:

```bash
openclaw gateway restart
```

To upgrade, follow [upgrading](https://ageorgiou.com/openclaw-jarvis-gilfoyle/operations/#upgrade): back up the board, apply any schema step the [changelog](CHANGELOG.md) lists, then install the new version. See the [configuration reference](https://ageorgiou.com/openclaw-jarvis-gilfoyle/board-reference/#configuration) for optional settings and [plugin schema](openclaw.plugin.json) for the authoritative shape.

## Everyday workflow

1. **Start in the project chat.** Ask product to create a project and record its context; messages are bound to that chat.
2. **Request work.** Product adds a task for engineering, which works in a private task session, delegates to workers and hands back a result with a note.
3. **Answer and review.** Product brings questions to you in the chat, passes answers back, then checks the result, closes the task and tells you what changed.

By default, the board scans every **60 seconds** for changed tasks or due check-ins (normally **60 minutes**). It wakes the holding manager without interrupting an active turn; user-held tasks get no automatic wakes. Use `/model` and `/think` in the project chat to choose settings for both managers' private task sessions; otherwise agent defaults apply.

The [board reference](https://ageorgiou.com/openclaw-jarvis-gilfoyle/board-reference/) covers all seven `project_board` operations, handover rules, scheduling, delivery and operator methods.

## Safety and limitations

- **Trusted host, not a sandbox.** Private task-session replies are suppressed from user chats. Hook errors are logged and ignored, except that a worker launch from a task session is refused while the running workers cannot be counted. Keep OpenClaw tool permissions and worker isolation in place; keep the board, transcripts and attachment files on a trusted host.
- **Scoped coordination.** Only product controls project lifecycle, chat binding and user messages. Private task sessions are scoped to their project; stale handovers require a reread. The plugin does not constrain other agents or product's personal-assistant work.
- **Workers and pauses.** Running workers prevent `done`; cancellation stops them, and the scan retries until each is confirmed stopped. Pausing stops automatic wakes and new workers, but does not stop existing workers. `worker.limit` counts the workers the engineering manager launched from task sessions that are running now, plus launches still starting; a launch whose completion never arrives stops counting after 16 minutes. The count lives in the gateway process, so it is a coordination limit, not a hard cap across restarts. See the [worker guards](https://ageorgiou.com/openclaw-jarvis-gilfoyle/board-reference/#worker-and-messaging-guards).
- **Delivery and retention.** Messages retry to the project chat with an owner-DM fallback; once the text is delivered, attachments are retried in the same chat. Delivery can still fail: check board/health output for undelivered messages. Attachment files must remain available until delivery finishes. SQLite survives restarts; closed-task private sessions are kept for seven days, then removed once idle.

See [enforcement and delivery rules](https://ageorgiou.com/openclaw-jarvis-gilfoyle/board-reference/#enforcement) for exact boundaries and [testing limitations](TESTING.md#native-integration) for live models, real channels and real-Gateway cleanup.

For consistent private board snapshots and safe staged verification, see [backup and recovery](https://ageorgiou.com/openclaw-jarvis-gilfoyle/recovery/). The operator utility never replaces the live board.

## Development

```bash
npm ci
npm run format:check
npm run check
npm test
npm run pack:check
openclaw plugins install --link . --force --accept-capabilities   # run a local checkout
```

A linked checkout loads `dist/` at Gateway startup; rebuild and restart after source changes. Releases are cut by pushing a `vX.Y.Z` tag on `main`, as described in [AGENTS.md](AGENTS.md#releases).

[TESTING.md](TESTING.md) explains the checks and their side effects. [CI](https://github.com/ag14774/openclaw-jarvis-gilfoyle/blob/main/.github/workflows/ci.yml) runs the checks above; native integration is optional on manual dispatch. Browse the [source](src/index.ts), [coordination skill](skills/project-coordination/SKILL.md) and [changelog](CHANGELOG.md) for implementation details and changes.
