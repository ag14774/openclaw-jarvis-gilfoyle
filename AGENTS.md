# Repository engineering standards

This file takes precedence over general defaults and over any skill's default rules, including the code-review skill's. Where they differ, follow this file.

## What this plugin is and where it runs

The plugin is a small substrate: a board (projects, tasks with a holder, notes, messages), wake-ups and guaranteed delivery for two cooperative manager agents on one trusted host. Agents interpret, plan, decide and write the wording; the plugin keeps the records, wakes the right agent and delivers messages.

It has one owner and one installation, on the owner's own gateway. There are no other users to keep compatible:

- Write no backward-compatibility, migration or upgrade code. A schema change bumps the schema version; the operator applies it to the board once, by hand, when upgrading (the CHANGELOG entry gives the exact statements).
- Handle only states the deployed or new code can produce. Code that never ran on the live system left nothing behind to handle.
- The engineering manager states in your assignment which version is deployed and any facts about the live system that matter.

## Design rules

Before a change, read the current source, the bundled skills, the README, `docs/board-reference.md`, `TESTING.md` and the CHANGELOG. Make the smallest change that does what was asked, and preserve unrelated work. Architecture, security, spending and production decisions stay with the owner.

- Never be more complicated than necessary, and never simpler than the requirements need.
- Handle a new situation by giving agents better context or procedure, not a new code path. Enforce a rule in code only when it is cheap and mechanical: checkable from the caller, the existing rows or a native call the plugin already makes, adding at most a column. Anything needing a new table, state machine, external verification or interpretation of free text stays with the agents.
- When something goes wrong, find the general cause before changing code. Prefer, in this order: correcting the agent procedure or context; fixing or simplifying the existing mechanism; removing the special case that caused it. Add a stage, status, flag, operation, table or branch only when the problem strictly cannot be solved otherwise.
- Never turn one incident, test case or review finding into a special case. A fix names the class of problem it handles and works for cases nobody listed. When fixes keep landing in the same mechanism, replace the mechanism with a simpler one.
- Free text stays free text: never parse notes, plans, descriptions or messages for machine meaning.
- Robustness comes from a few durable facts and simple self-recovering rules (retry with the same identity, check again later, tell the user when stuck), not from anticipating every scenario. Handle what happens in normal use on this host; for rare races, prefer recovering on the next scan over preventing them with more machinery.
- The plugin acts only on its own tool and private task sessions and fails open. It never constrains the product manager's personal-assistant work or other agents.
- New tables, tool operations, task statuses or configuration settings need the owner's approval.

## Size

Prefer changes that keep or reduce the size of the code. When a change adds code, look for what it makes removable. Report the line count change of `src/` in the PR; when it grows, say what you considered removing.

## Working on the code

Keep SQLite transactions synchronous and never hold one across a native call; re-read what a decision depends on after a native call returns. Native sessions are the authority for liveness, native receipts for delivery.

Use fake native APIs and disposable files for tests; one test per behaviour, no tests for states the code cannot produce. Run `npm run format:check`, `npm run check`, `npm test`, `npm run test:native` and `npm run pack:check`. Native tests inspect the pinned package, not a live gateway, and the build transpiles without type checking. Report mocked, native-export, CI and live evidence separately. Live gateway or install changes, channel sends, deployment and repository visibility changes need the owner's authorization.

## Documentation

Repository docs state current behaviour in plain, short language, without lists of caveats. Test evidence and investigation details go in PRs, not in docs or code comments. Keep the CHANGELOG's Unreleased section a description of the net change since the last release, not of intermediate designs.

Public documentation uses standard Zensical and publishes from `main` through GitHub Pages Actions. Keep the account's custom-domain routing, and check documentation and generated assets for private content before publishing. The README links the documentation site, without embedded screenshots. Preserve branding, licence and privacy choices and the append-only CHANGELOG history.

## Releases

`package.json` holds the one version number. Versions are year.month.sequence: the first release in a month is `YYYY.M.0`, and each later one that month adds one to the last number. To release:

1. In a normal PR, run `npm version <X.Y.Z> --no-git-tag-version` and turn the CHANGELOG's Unreleased section into `## X.Y.Z - <date>`. When the release changes the board schema, start that section with the exact statements the operator runs.
2. After it merges, tag the merge commit on `main` and push the tag: `git tag -a vX.Y.Z -m vX.Y.Z <commit>`, then `git push origin vX.Y.Z`.
3. The Release workflow checks that the tag, `package.json` and the CHANGELOG agree, runs every check, creates the GitHub release with the package and its checksum, and publishes the version to ClawHub. ClawHub makes it installable after its security review, which the workflow does not wait for; check that ClawHub lists the version before upgrading.

Never move a tag once its release is published; fix a bad release with a new version. A tag whose workflow failed before publishing anything can be deleted and pushed again after the fix.
