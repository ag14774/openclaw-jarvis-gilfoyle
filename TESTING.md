# Testing

## Behavioral Suite

`npm test` rebuilds `dist/` (via `pretest`) and runs `test/*.test.ts` against `src/` with Node's test runner and `tsx`. `node --import tsx --test test/*.test.ts` runs the same suite without rebuilding.

`test/support/harness.ts` registers the real plugin with a fake native gateway and drives it only through the real `project_board` tool and hooks: `message_received`, `before_prompt_build`, `before_tool_call`, `after_tool_call`, `agent_end`, `before_agent_run` and `message_sending`. The fake gateway provides conversations, sessions, sends, agent runs, aborts and session cleanup, on a controllable clock. It rejects any other native method. No test contacts a gateway, a channel or a repository. The rpc-bridge child process is not exercised.

`test/board.test.ts` covers, one behavior per test:

- the request round trip, from user to engineering and back to the user;
- a question to the user and the answer back to engineering;
- when a message is required, and that the project chat is not told twice;
- handovers only by the holder and from the latest notes;
- roles, project isolation and closed tasks;
- stall reporting and check-ins;
- workers: profiles, the limit, cancellation and the done guard;
- pause and resume;
- per-role concurrency;
- delivery fallback and retry identity;
- `use_this_chat` turn binding;
- non-interference with personal work and other agents;
- the board file surviving a restart, and refusal of a database with another schema;
- one shared board when OpenClaw registers the plugin more than once in a process.

The fakes follow OpenClaw 2026.9.2 as found in its distribution:

- `hasActiveRun` is the live-turn signal;
- `sessions_spawn` results carry `details.childSessionKey`;
- `conversations.send` receipts are `sent`, `queued`, `suppressed` or `unknown`, and `queued` means durably queued;
- a repeated `operationId` does not send twice.

## Native Integration

`npm run test:native` (`JG_NATIVE_TEST=1`) also checks that every native method the companion calls exists in the pinned OpenClaw build. It reads the installed package only.

Not covered by automated tests: live model behavior, code-mode tool dispatch through the hooks, real channel delivery, and session cleanup against a real gateway. These need a live, explicitly authorized run.

## Build And Package

`npm run check` builds `dist/`, syntax-checks it and runs `scripts/verify-dist.mjs` against the compiled registration and store. `npm run pack:check` inspects the package boundary.

## Formatting

`npm run format` applies Prettier. `npm run format:check` is enforced in CI.
