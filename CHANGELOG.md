# Changelog

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
