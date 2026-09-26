# Changelog

## 2.3.0 - 2026-09-18

- Replaced lexical read-only closure with one generic `finalize` operation for settled non-publication outcomes and idempotent missing-notification repair.
- Removed enumerated terminal-summary prefixes; terminal validity now uses durable completion and passed evidence.
- Replaced runtime-authored recovery blockers with structured communication intents that Jarvis composes or dismisses.
- Required Jarvis-composed question wording and preserved that wording verbatim during fallback delivery.
- Defined `todo`, `running`, `blocked`, and `done` as the canonical project-card statuses; other native statuses now require reconciliation.
- Migrated v2 registries in place to v3 communication-intent storage.

## 2.2.4 - 2026-09-18

- Removed deployment-specific defenses for obsolete canonical-main controls and `REPLY_SKIP`; reusable behavior relies on the current protocol and clean manager sessions.
- Retained the current companion guard and claim-release methods required by real delegation preparation and recording.

## 2.2.3 - 2026-09-17

- Fixed real delegation preparation by permitting the project-active guard through the companion RPC boundary.
- Permitted claim release through the companion so accepted worker bindings can complete atomically.
- Blocked obsolete project-control forwarding and same-agent canonical-main forwarding through `sessions_send`.
- Suppressed the internal `REPLY_SKIP` loop-control token at the user-facing reply hook.

## 2.2.2 - 2026-09-17

- Require every worker worktree to exist before delegation preparation.
- Validate unique registration, branch pairing, repository identity, canonical root, immutable base HEAD, cleanliness, and integration-checkout isolation for ordinary attempts as well as reviews and replacements.
- Reject reuse of another Work item's retained branch or worktree identity.

## 2.2.1 - 2026-09-17

- Added Prettier with write and non-mutating check commands.
- Added basic GitHub Actions CI for formatting, build, behavioral tests, and package checks.
- Added an explicit manual native OpenClaw integration lane.
- Removed source-text inspection, opaque-hash duplication, and exact harmless-read-count tests.
- Removed private OpenClaw sanitizer loading from the default behavioral suite.
- Strengthened GitHub failure fixtures to reject unarranged endpoints and corrected one false-positive workflow test.

## 2.2.0 - 2026-09-17

- Replaced configured opaque conversation references with native fallback destinations.
- Added exact address resolution by channel, account, recipient, kind, and optional thread.
- Refreshes the current conversation reference before every fallback send.
- Fails closed without sending when a fallback address is missing or ambiguous.

## 2.1.0 - 2026-09-17

- Replaced separate worker/advisor model settings with 1–5 ordered worker profiles.
- Added explicit profile discovery and required `profileId` selection for every new attempt.
- Persisted concrete profile ID, model, and thinking with each attempt and reconciliation archive.
- Removed the dedicated advisory operation and configuration.
- Removed the legacy v1 registry migration path; only fresh/current v2 state is accepted.

## 2.0.1 - 2026-09-17

- Moved TypeScript behavioral tests and support code under `test/`.
- Kept behavioral tests source-only and moved compiled-output verification to `scripts/verify-dist.mjs`.
- Removed host-specific test paths and resolved pinned OpenClaw integration fixtures dynamically.
- Removed stale root migration artifacts and kept generated `dist/` out of Git.

## 2.0.0 - 2026-09-16

- Extracted the runtime into a standalone OpenClaw plugin package.
- Added configurable product, engineering, and worker agent identities.
- Added configurable worker runtime/model/reasoning and advisor model/reasoning/timeout.
- Replaced setup-specific persisted roles with `product` and `engineering`.
- Added the one-time v1 registry migration with role and session translation.
- Renamed public tools to `jarvis_project` and `gilfoyle_engineering`.
- Replaced branded internal control markers with `PROJECT WAKE` and `PROJECT CONTINUATION`.
- Added TypeScript source, compiled ESM runtime output, package compatibility metadata, and packed-artifact validation.
