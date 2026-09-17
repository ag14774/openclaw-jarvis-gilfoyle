# Testing

The suite is organized by observable contract rather than implementation function. Tests should follow Arrange, Act, Assert with one primary behavior per test.

## Behavioral Suite

`npm test` runs TypeScript tests against `src/`. It covers public plugin registration, project routing, durable records, worker preparation, handoffs, delivery, paging, hosted evidence, and failure behavior.

Prefer assertions about returned values, durable state, externally visible RPC effects, and absence of unsafe mutations. Do not assert source text, import graphs, private helper calls, opaque hash construction, or an exact number of harmless reads.

Exact assertions remain appropriate for deliberate protocol contracts such as idempotency keys, persisted evidence formats, byte limits, safe RPC payloads, exact candidate binding, and at-most-once mutations.

## Native Integration

`npm run test:native` additionally runs isolated tests against the exactly pinned OpenClaw version. These tests use disposable SQLite databases and Git worktrees. They are a compatibility lane, not ordinary unit tests, because they exercise pinned OpenClaw native-store behavior.

## Build And Package

`npm run check` builds `dist/`, performs JavaScript syntax checks, and runs the portable compiled-distribution verifier. Unit tests never import `dist`.

The current TypeScript build uses `noCheck` because the runtime was migrated from dynamic JavaScript contracts. Build success is emission and runtime verification, not a claim of static type safety.

`npm run pack:check` inspects the release package boundary without rerunning lifecycle scripts.

## Formatting

`npm run format` applies Prettier. `npm run format:check` is non-mutating and is enforced in CI.
