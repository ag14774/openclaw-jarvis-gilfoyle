# Repository engineering standards

This plugin is a small board, wake scan and delivery substrate for cooperative agents on a trusted host. Agents own interpretation and wording; plugin code enforces cheap mechanical invariants from callers, existing rows and native APIs. Preserve personal assistance outside project work.

Before changes, inspect the current source, bundled project-coordination skill, README, docs/board-reference.md, TESTING.md and CHANGELOG.md. Make the smallest requested change. Prefer better agent procedure, correction or simplification of existing mechanisms over additional orchestration. Never parse free-text notes, descriptions or messages for machine meaning or add incident-specific branches. New tables, statuses, tool operations or settings require explicit approval. Material architecture, security, spending and production decisions remain with the owner.

Keep SQLite transactions synchronous; revalidate decisions after native awaits before committing. Native sessions are authoritative for liveness, native receipts for delivery. Preserve uncertainty, retry from existing durable facts, and never claim a hard limit or confirmed effect without evidence. Trusted-host guards are not hostile-code containment.

Use fake native APIs and disposable files for regression coverage. Run npm run format:check, npm run check, npm test, npm run test:native and npm run pack:check. Native tests inspect the pinned package, not a live gateway. Build transpiles with noCheck; it is not static type verification. Report mocked, native-export, CI and live evidence separately. Live gateway/install changes, channel sends, production deployment and repository visibility changes need separate authorization.

Public documentation uses standard Zensical and publishes from accepted main changes through GitHub Pages Actions. Keep the plugin repository private, preserve account custom-domain routing, and scan documentation and generated assets for private content before publishing. README links the verified documentation site without embedded preview screenshots.

Repository docs state current behavior and limitations. Keep test evidence and investigation details in PRs, not runtime policy. Preserve unrelated changes, branding, license/privacy choices and append-only history.
