# Testing

The suite is organized by observable contract rather than implementation function. Tests should follow Arrange, Act, Assert with one primary behavior per test.

## Behavioral Suite

`npm test` runs TypeScript tests against `src/`. It covers public plugin registration, fresh registry records, natural-note invariance, registered-only scanning, reservation and interruption recovery, delivery authority, worker bindings and replacements, decisions, controls, publication/terminal sequencing, dispatch budgets, batching, routing, schedules, hosted evidence, and failure behavior.

Prefer assertions about returned values, durable state, externally visible RPC effects, and absence of unsafe mutations. Do not assert source text, import graphs, private helper calls, opaque hash construction, or an exact number of harmless reads.

Exact assertions remain appropriate for deliberate registry contracts such as relationship identities, persisted structured records, safe RPC payloads, exact candidate binding, and at-most-once mutations. Card prose and formatting are intentionally not machine contracts.

## Native Integration

`npm run test:native` additionally runs isolated tests against the exactly pinned OpenClaw version. These tests use disposable SQLite databases and Git worktrees. They are a compatibility lane, not ordinary unit tests, because they exercise pinned OpenClaw native-store behavior.

## Build And Package

`npm run check` builds `dist/`, performs JavaScript syntax checks, and runs the portable compiled-distribution verifier. Unit tests never import `dist`.

The current TypeScript build uses `noCheck` because the runtime was migrated from dynamic JavaScript contracts. Build success is emission and runtime verification, not a claim of static type safety.

`npm run pack:check` inspects the release package boundary without rerunning lifecycle scripts.

## Formatting

`npm run format` applies Prettier. `npm run format:check` is non-mutating and is enforced in CI.
