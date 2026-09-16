# Changelog

## 2.0.0 - 2026-09-16

- Extracted the runtime into a standalone OpenClaw plugin package.
- Added configurable product, engineering, and worker agent identities.
- Added configurable worker runtime/model/reasoning and advisor model/reasoning/timeout.
- Replaced setup-specific persisted roles with `product` and `engineering`.
- Added the one-time v1 registry migration with role and session translation.
- Renamed public tools to `jarvis_project` and `gilfoyle_engineering`.
- Replaced branded internal control markers with `PROJECT WAKE` and `PROJECT CONTINUATION`.
- Added TypeScript source, compiled ESM runtime output, package compatibility metadata, and packed-artifact validation.
