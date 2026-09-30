# Changelog

## 6.2.3 - 2026-09-30

- The manager role line now says the project role adds to the manager's usual role, and a project chat is described as "also used as" the project chat. Jarvis had described himself as only Quote Desk's product manager in the owner DM, which is also that project's chat.

## 6.2.2 - 2026-09-29

- The model is applied to private task sessions with write scope only and the thinking level in a separate call. With admin scope OpenClaw also made the model the configured default (sticky model selection).
- A closed task's private session recreated by a late native turn (such as a cancelled worker's completion notice) is blocked, as before, and now removed again by the next scan.

## 6.2.1 - 2026-09-29

- A user message in a project's chat records the session OpenClaw routed it to, so the chat's session follows resets of session scope or deleted sessions, and projects bound before 6.2.0 pick it up without `use_this_chat`. Messages in other chats, such as the owner DM for a project with its own chat, never change it.

## 6.2.0 - 2026-09-29

Protocol 11.3.

- Private task sessions of both managers follow the model and thinking level the user chose in the project chat, read at every wake; otherwise the agents' defaults. The project chat binding now also records the product manager's session for that chat. Projects bound earlier need `use_this_chat` once.
- The companion may call `sessions.patch`, limited to the model and thinking level of the plugin's private task sessions.

## 6.1.1 - 2026-09-29

Skill only (protocol 11.2): the engineering manager keeps one checkout per repository in the projects directory named in its local notes, gives each worker assignment its own worktree and branch with the worker's `cwd` set to it, removes worktrees after merge or cancellation, and records the checkout path in the project context.

## 6.1.0 - 2026-09-29

Fixes from the first live runs (protocol 11.1).

- Registrations of the plugin in one process share one board, so the chat of a user's message reaches a tool call made through another registration, and there is one scan and one bridge.
- The engineering manager hands over or closes only tasks it holds. A handover or close is refused when the calling session has not read a newer note in this turn.
- In the project chat a `message` passed with a handover or close is not sent in addition to the reply.

## 6.0.0 - 2026-09-29

Breaking rewrite as a small project board. (5.0.0 was never released.)

- One tool, `project_board`, replaces `jarvis_project` and `gilfoyle_engineering`. It has seven operations: `list`, `show`, `create_project`, `update_project`, `add_task`, `update_task` and `notify`.
- Fresh-only schema v16 with four tables: projects, tasks with a holder (whose turn it is), notes and outbox. Features, requests, obligations, decisions, schedules, repositories, verifiers, attention stages and pause dispositions are removed.
- The scan wakes a task's holder in its own private session when someone else changed the task or its check-in is due. After three unproductive wakes the user is told once.
- Required notifications travel with the change: handing a task to the user, or closing a product task, needs the user message in the same call, except from the project chat.
- Cheap enforcement: role ownership, project isolation, notes on handovers and closing, worker recording with profile application and a limit, no done while workers run, cancel aborts workers, turn-bound `use_this_chat`, and delivery only to the project chat or the owner DM.
- Configuration: `ownerChat` replaces `fallbackDestinations`, and `turnTimeoutSeconds` replaces `continuationTimeoutSeconds`. `maxWakesPerRole` is new; `checkoutRoot` is gone. Worker profiles need only `id` and `model`.

## 4.1.0 - 2026-09-27

- Bundle the role-neutral `project-coordination` skill with the plugin and load it through native manifest skill discovery.
- Tell each manager its project role and only its counterpart's configured display name and agent ID, with configured-name/ID fallbacks; do not repeat the agent's own identity or alter personas or permissions.

## 4.0.0 - 2026-09-27

- Replace the legacy card-note protocol with a fresh-only v9 registry for requests, Features, recoverable creation payloads, scope revisions, obligations, dependencies, attempts, decisions, publication/terminal checkpoints, stop controls, explicit inactivation plans and source-idempotent schedules.
- Keep Workboard status and native task liveness out of SQLite; scans join registered obligations to native Workboard/task/session evidence and ignore unregistered cards.
- Remove project-information and owner-notification cards, creation seals, machine note fields, attempt blocks, replacement comments, hosted note checkpoints and handoff JSON.
- Give one multi-repository intake one request identity with board-local Features; represent stops as control intents and exceptional intervention work as normal obligations.
- Retain conversation routing, delivery receipts, schedules, exchanges, worker profiles/capacity, GitHub effect validation and internal context cleanup.
- Replace legacy compatibility tests with fresh-schema, natural-note invariance, unregistered-card exclusion, no-retired-marker and isolated-native coverage.
- Reserve Feature/obligation identity before native creation, recover ambiguous writes, lock reviews to registry candidates, require exact passed publication gates, and guard direct Feature completion.
- Stage held terminal communication before completion so restart reconciliation releases only Jarvis-authored result delivery after exact native proof.
- Reconcile stop controls against terminal tasks, inactive sessions and closed hosted effects; reset dispatch retries only when durable attention versions change.
- Settle batched members with actual receipts/routes and process copies by each original event.
- Scope every decision read/write to its project and recover answered ownership back to engineering, including scanner attention when native projection is interrupted.
- Restore exhaustive `finish|stop|pending` inactivation dispositions and prevent pending work from running while safely preserving it.
- Use exact line-delimited worker identity and exact per-child session searches; exhausted unchanged attention creates one durable product blocker intent.
- Accept marker-like human prose without special parsing or vocabulary restrictions.
- Recover merged publication checkpoints through terminal completion, treat uncheckpointed done Features as actionable uncertainty, and guard every supported move-to-done tool.
- Enforce exact Feature scope for engineering and internal product mutations, enforce product lifecycle authority, isolate failed schedule occurrences, and count only configured ACP worker capacity.
- Confirm temporary-context cleanup before closure and rediscover fallback destinations on every fallback attempt without changing preferred routes.

## 3.0.1 - 2026-09-26

- Move validated repository configuration from permanent Workboard TODO cards into v5 registry board associations; v4 upgrades in place and historical cards are no longer runtime authority.
- Bind accepted native execution without requiring a manager claim or reopening completed/blocked work; atomically store receipt and references.
- Reconcile unique native task bindings after spawn and on recovery scans; unresolved or active execution cannot be hidden by completed card status.
- Keep review findings and labels free-form while validating immutable candidate and independent execution identity.
- Prevent substitute reviews while original execution is unresolved; expose query schema and actionable binding diagnostics.
- Permit either manager to request active-project reconciliation, reserve retry-budget resets for operators, and guard native completion against unresolved execution.
- Verify the exact reviewed GitHub candidate object without requiring local integration HEAD to advance before the PR; retain remote/base/review/CI/merge validation.
- Compare hosted checkpoint state structurally so native response field ordering does not masquerade as concurrent modification; real state changes still reject.
- Permit completion wording to describe the actual merge while verifying the retained gate's unchanged publication identity and receipt.

## 3.0.0 - 2026-09-26

- Agents decide scope, work structure and conclusions; shared terminal handoff supports settled success, failure, cancellation and findings without an outcome taxonomy.
- Replace question-category routing with explicit `decisionBy` authority and one manager decision operation; retain real user-answer provenance.
- Add source-bound scope amendments, meaningful native card states, read-only manager access and scoped private consultations.
- Bind review execution to assignment fields instead of exact English; support verified squash trees as well as merge commits; make worker capacity configurable.
- Preserve manager-authored optional fallback explanations, expose validation conditions, and check controller tasks before temporary-context cleanup.
- Breaking tool contract: work intake/schedules use `authorized`, decision operation is `decide`, and a fresh v4 registry is required. No old-record migration or compatibility aliases.

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
