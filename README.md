# OpenClaw Jarvis-Gilfoyle

Jarvis-Gilfoyle is an OpenClaw plugin for a fixed, configurable project topology:

```text
user -> product agent -> engineering agent -> implementation/review workers
```

The names are thematic. Runtime authority and persisted state use generic `product` and `engineering` roles mapped to configured OpenClaw agent IDs.

## Tools

- `jarvis_project`: durable project identity, conversation routing, intake, lifecycle, schedules, answers, and receipt-backed notifications.
- `gilfoyle_engineering`: validated Workboard records, worker binding, handoffs, publication gates, reports, and advisory launch arguments.

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
openclaw plugins install npm-pack:./openclaw-jarvis-gilfoyle-2.0.0.tgz --force --accept-capabilities
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
        "hooks": {"allowConversationAccess": true, "allowPromptInjection": true},
        "config": {
          "enabled": true,
          "statePath": "/absolute/path/to/state.sqlite",
          "productAgentId": "main",
          "engineeringAgentId": "gilfoyle",
          "workerAgentId": "opencode",
          "sessionNamespace": "jarvis-gilfoyle",
          "scanMs": 60000,
          "fallbackConversations": {
            "product": "conv_product_owner_dm",
            "engineering": "conv_engineering_owner_dm"
          },
          "worker": {"runtime": "acp", "model": "openai/gpt-5.6-sol", "thinking": "high"},
          "advisor": {"model": "openai/gpt-6-astra", "thinking": "low", "timeoutSeconds": 600}
        }
      }
    }
  }
}
```

Grant `jarvis_project` and `gilfoyle_engineering` to both configured manager agents. The plugin enforces their different authorities internally.

The managed install record locates the package. Do not also add the same checkout to `plugins.load.paths`. For an unmanaged development load instead, omit `plugins install` and set `plugins.load.paths` to the repository path.

## Development

Requires Node.js with `node:sqlite` and OpenClaw `2026.9.2`.

```bash
npm ci
npm run build
npm run check
npm test
npm pack --dry-run
```

Source entrypoints are declared in `package.json` under `openclaw.extensions`; managed installs use the corresponding `openclaw.runtimeExtensions` compiled entrypoint. `openclaw.plugin.json` owns plugin identity, tool contracts, and configuration schema. `openclaw.json` owns enablement, grants, hooks, and deployment-specific configuration.

The behavioral suite uses Node's built-in `node:test` runner with `tsx` to execute `src/**/*.ts`. A separate distribution smoke test imports `dist/**/*.js`, and package validation inspects the packed artifact. This keeps source-unit, compiled-runtime, and package-boundary failures distinct.

The v2 store performs a one-time v1 migration from named conversation columns and agent-ID role values to generic columns and `product|engineering` roles. Stop the Gateway and back up the registry before opening a v1 database with v2.

Internal control prompts use the semantic markers `PROJECT WAKE` and `PROJECT CONTINUATION`; the public brand is deliberately excluded from those markers.
