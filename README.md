# OpenClaw Jarvis-Gilfoyle

Jarvis-Gilfoyle is an OpenClaw plugin for a fixed, configurable project topology:

```text
user -> product agent -> engineering agent -> implementation/review workers
```

The names are thematic. Runtime authority and persisted state use generic `product` and `engineering` roles mapped to configured OpenClaw agent IDs.

## Tools

- `jarvis_project`: durable project identity, conversation routing, intake, lifecycle, schedules, answers, and receipt-backed notifications.
- `gilfoyle_engineering`: registered Workboard obligations, ordered worker profiles, worker binding, decisions, publication gates, and reports.

## Installation

OpenClaw managed installs execute the compiled files in `dist/`. TypeScript is a development input, not a runtime requirement for a packed release.

### Linked Checkout

Use this while developing from a local clone:

```bash
git clone https://github.com/ag14774/openclaw-jarvis-gilfoyle.git
cd openclaw-jarvis-gilfoyle
npm ci
npm run build
openclaw plugins install --link . --force --accept-capabilities
```

`--link` creates a managed OpenClaw install record that points to the checkout. After changing source, run `npm run build` and restart the Gateway. A linked install does not copy the repository.

Routine builds compile in place and do not delete the active `dist` directory. `npm run clean` is an explicit maintenance command; do not run it while the linked plugin is serving.

### Packed Artifact

Use this to validate the same package boundary used by a registry release:

```bash
npm ci
npm pack
openclaw plugins install npm-pack:./openclaw-jarvis-gilfoyle-4.1.0.tgz --force --accept-capabilities
```

The tarball contains compiled JavaScript, so its consumer does not need TypeScript. Installation records the package but leaves it disabled if required configuration is absent.

### GitHub Checkout

The Git repository intentionally does not track generated `dist/` files. Clone it, run `npm ci` and `npm run build`, then use the linked-checkout command above. Do not install the raw Git URL unless a future tagged release explicitly includes compiled artifacts.

## Configuration

```json
{
  "plugins": {
    "entries": {
      "jarvis-gilfoyle": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true, "allowPromptInjection": true },
        "config": {
          "enabled": true,
          "statePath": "/absolute/path/to/state.sqlite",
          "productAgentId": "main",
          "engineeringAgentId": "gilfoyle",
          "sessionNamespace": "jarvis-gilfoyle",
          "scanMs": 60000,
          "fallbackDestinations": {
            "product": {
              "channel": "telegram",
              "accountId": "default",
              "to": "telegram:123456789",
              "kind": "direct"
            },
            "engineering": {
              "channel": "telegram",
              "accountId": "gilfoyle",
              "to": "telegram:123456789",
              "kind": "direct"
            }
          },
          "worker": {
            "agentId": "opencode",
            "runtime": "acp",
            "profiles": [
              {
                "id": "sol-low",
                "model": "openai/gpt-5.6-sol",
                "thinking": "low",
                "description": "Routine bounded implementation, inspection, and straightforward tests."
              },
              {
                "id": "sol-medium",
                "model": "openai/gpt-5.6-sol",
                "thinking": "medium",
                "description": "Complex implementation, debugging, and independent review."
              },
              {
                "id": "astra-low",
                "model": "openai/gpt-6-astra",
                "thinking": "low",
                "description": "Unusually difficult architecture, security, or diagnosis."
              }
            ]
          }
        }
      }
    }
  }
}
```

Grant `jarvis_project` and `gilfoyle_engineering` to both configured manager agents. The plugin enforces their different authorities internally.

The plugin bundles the shared `project-coordination` skill through its manifest. It uses role-neutral product-manager/engineering-manager language; runtime prompt context tells each manager its role and its counterpart's display name and ID, without repeating its own identity. Names come from native `agents.entries[id].identity.name`, then `name`, then the ID. Display names do not change routing, authority or personas. No install-time generation is needed. Remove any manually installed copy of this procedure when adopting the bundled skill, because managed/workspace skills take precedence over plugin skills.

Worker profiles are ordered from lowest to highest capability and are limited to five. Gilfoyle selects the lowest adequate `profileId` during `prepare`; arbitrary model overrides are rejected. Each attempt retains its concrete profile ID, model, and thinking level, so later configuration changes do not rewrite execution evidence.

Every implementation or review worktree must be created before `prepare`. The plugin validates that the worktree is uniquely registered with its branch, belongs to the selected repository, is a clean canonical root at the immutable base SHA, is distinct from the integration checkout/branch, and does not reuse another retained attempt identity. The returned `spawnArgs.cwd` binds the worker to that validated worktree; the plugin does not create worktrees or spawn workers itself.

Fallback destinations use OpenClaw's native `channel`/`accountId`/`to` address format, with optional `threadId`. The plugin requires direct destinations, rediscovers one exact current conversation reference before every fallback send, and fails closed when the address is unavailable or ambiguous. Opaque `conversationRef` values do not belong in static configuration.

Agents decide intent, scope, decomposition and conclusions. The plugin validates identity, authority, settled execution and delivery. `finalize` accepts settled work without imposing an outcome taxonomy. Publication adapters verify claimed external effects and call the same terminal completion. Recovery records facts for the product manager to explain. Optional `fallbackMessage` preserves a manager-authored explanation when the preferred route fails.

Accepted execution binding is bookkeeping, not a new permission grant. `prepare` and `record` retain attempt, worktree, profile and native task identities in registry rows after checking actual native task evidence. Spawn/completion hooks and shared scans recover uniquely matching native runs. Duplicate or incomplete evidence stays visible in `bindingDiagnostics`; the runtime never chooses between multiple executions or launches a replacement for a missing receipt. Independent-review findings remain free text while the registry binds the review obligation and publication candidate.

Native Workboard states retain useful semantics: triage requires judgment, backlog/scheduled defer, todo/ready are open, review awaits verification, blocked retains a hold and done is settled. Worker liveness comes from task/session evidence, not card status. `worker.limit` configures cooperative capacity (default two); the native manager claim slot remains a platform constraint.

`intake` and `schedule` require `authorized:true` for requested work, without treating inspection as modification permission. Optional stable `requestKey` separates requests in one message. One request can own one board-local Feature per selected repository. `amend` appends a per-Feature scope revision, updates the human note projection, and invalidates that Feature's publication checkpoint without changing sibling Features or shared request scope. `handoff` and `decide` use registry decision rows; only correlated user answers resolve user-reserved decisions. `control` records a stop intent without creating a card. Actual exceptional intervention work remains an ordinary registered Workboard obligation.

## Authority Model

The fresh v9 registry owns projects, routes, requests, board-to-Feature associations, recoverable native creation payloads, per-Feature scope revisions, obligation relationships, immutable review candidates, dependencies, attempt bindings, decisions, publication and terminal checkpoints, stop controls, explicit inactivation plans, source-idempotent schedules, exchanges, communication intents, and delivery receipts. It deliberately does not store Workboard status or native task liveness. Workboard owns human-visible obligation status, owner, conclusion and proof; native tasks/sessions own execution liveness; Git and GitHub own repository and publication effects.

Card notes are natural human scope and context. They are never parsed for project identity, source, delivery, type, Feature membership, dependencies, attempts, decisions, publication state, or creation seals. Marker-like words and snippets are valid prose and have no machine effect; validation is limited to size and unsafe control characters. Scans start from registered obligations and ignore unregistered cards. Result delivery rows and native conversation receipts are the sole notification authority; no owner-notification card is created.

The managed install record locates the package. Do not also add the same checkout to `plugins.load.paths`. For an unmanaged development load instead, omit `plugins install` and set `plugins.load.paths` to the repository path.

## Development

Requires Node.js with `node:sqlite` and OpenClaw `2026.9.2`.

```bash
npm ci
npm run build
npm run format:check
npm run check
npm test
npm pack --dry-run
```

Source entrypoints are declared in `package.json` under `openclaw.extensions`; managed installs use the corresponding `openclaw.runtimeExtensions` compiled entrypoint. `openclaw.plugin.json` owns plugin identity, tool contracts, and configuration schema. `openclaw.json` owns enablement, grants, hooks, and deployment-specific configuration.

The behavioral suite under `test/` uses Node's built-in `node:test` runner with `tsx` against `src/**/*.ts`; tests never import `dist`. `npm run check` separately builds and verifies the compiled registration/store boundary through `scripts/verify-dist.mjs`, and package validation inspects the packed artifact. These checks work on any machine with the declared Node and OpenClaw versions. See `TESTING.md` for test-layer and Arrange/Act/Assert guidance.

Cross-authority writes reserve registry identity before native creation and retain recoverable staged checkpoints. Terminal completion stages facts for Jarvis before completing the Feature; only after native completion is confirmed can Jarvis compose the result delivery. Direct Feature completion requires that durable terminal checkpoint. Stops block new preparation, publication and finalization until engineering reconciles native tasks/sessions and any hosted effect.

Worker execution currently requires the ACP runtime plus its native wrapper task; `worker.runtime` is therefore fixed to `acp` rather than advertising unsupported alternatives.

Current state uses the fresh-only v9 project registry. Older plugin registries are rejected and are not migrated or parsed. Reset only the configured plugin `statePath`; personal OpenClaw state is separate and must not be erased.

Internal control prompts use the semantic markers `PROJECT WAKE` and `PROJECT CONTINUATION`; the public brand is deliberately excluded from those markers.

GitHub Actions runs formatting, compiled-output verification, behavioral tests, and package-boundary checks on Node `22.22.3`. The pinned native OpenClaw integration lane is available through manual workflow dispatch.
