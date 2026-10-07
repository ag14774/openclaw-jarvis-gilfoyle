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
- one shared board when OpenClaw registers the plugin more than once in a process;
- private task sessions following the project chat's model choice, the chat's session refreshed only from that chat, and the companion's limits on `sessions.patch` (one setting per call, the model never with admin scope);
- closed task sessions recreated by late native turns being removed again.

The fakes follow OpenClaw 2026.9.8 as found in its distribution:

- `hasActiveRun` is the live-turn signal;
- `sessions_spawn` results carry `details.childSessionKey`;
- `conversations.send` receipts are `sent`, `queued`, `suppressed` or `unknown`, and `queued` means durably queued;
- a repeated `operationId` does not send twice.

`test/admission.test.ts` drives the real `before_tool_call` and `after_tool_call` hooks with fake native sessions: simultaneous launches at the last free slot, parallel launches in one turn while there is room, refused and failed launches not holding a slot, a launch whose completion never arrives counting for 16 minutes, which running workers count, a worker target written in another case, and waiting out a full limit with ordinary check-ins.

`test/reliability.test.ts` drives the runtime directly with fake native calls that assert no SQLite transaction spans an await: changes made while a completion checks the workers, stopping a cancelled task's workers until they are confirmed stopped (and then no more checks), failed and timed-out wakes, actions made during a wake dispatch, attachments retried in the chat that received the text, simultaneous deliveries of one message, and refusal of a foreign database file.

These are mocked behavior tests, not live worker or hard-limit evidence.

## Native Integration

`npm run test:native` (`JG_NATIVE_TEST=1`) also checks that every native method the companion calls exists in the pinned OpenClaw build. It reads the installed package only.

Not covered by automated tests: live model behavior, code-mode tool dispatch through the hooks, real channel delivery, and session cleanup against a real gateway. These need a live, explicitly authorized run.

## Build And Package

`npm run check` builds `dist/`, syntax-checks it and runs `scripts/verify-dist.mjs` against the compiled registration and store. `npm run pack:check` inspects the package boundary.

## Recovery Utility

`npm run test:recovery` runs `test/recovery.test.ts` on disposable private temporary
fixtures only, without rebuilding. It is also included in `npm test`. The suite
uses the existing Store solely to make fixtures; the operator utility has no
runtime imports or dependency on OpenClaw. It covers committed, uncheckpointed WAL
data, exclusion of an uncommitted write, separate staged verification and hashes,
private permissions, no source checkpoint/journal change, existing destinations
and aliases, concurrent destination refusal, malformed/foreign/incompatible schema,
foreign-key violations, invalid CLI arguments, missing sources and refusal to
stage a WAL database. Tests remove their fixtures and never contact a gateway,
launch a worker or read real board/session data.

`scripts/board-backup.mjs` is the only operator script included in the package.
`backup` and `stage` create a new private directory with a database and report;
`verify` opens the explicitly supplied file read-only. See
[recovery](https://ageorgiou.com/openclaw-jarvis-gilfoyle/recovery/) for prerequisites, read-only WAL coordination caveats
and the separately authorized boundary before any live replacement. This is local
SQLite restore-readability evidence, not a live/off-host/full-host recovery test.

## Formatting

`npm run format` applies Prettier. `npm run format:check` is enforced in CI.
