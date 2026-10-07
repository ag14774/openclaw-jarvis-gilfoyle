# Changelog

## Unreleased

- Adopt a one-time monotonic 16-minute deadline when registration finds a retained launch-admission claim without one. Legacy claims have no recorded acquisition time, so their deadline starts at adoption; later registrations and reloads preserve it. Existing claim deadlines are unchanged.
- Add fixed 16-minute lazy expiry to the process-local launch-admission gate so a missing completion hook cannot block future admission indefinitely. Preserve count/launch/record serialization before expiry and the original monotonic deadline across runtime reload; revalidate ownership and expiry after native counts. Late completions still record known children without releasing newer claims. Expiry may permit overlap with a slow or ambiguous invisible worker; there is no hard restart-safe or cross-process capacity bound. Capacity check-ins are unchanged. No schema, operation, scheduler or setting was added.
- Replace accepted-only effect custody with same-process launch-invocation serialization through the matching completion hook. Record known children before release, including error/unknown results; report recording failures and release completed calls even when recording fails or the result is empty/missing. Native validation errors no longer strand subsequent launches. An absent completion hook stays locked across elapsed time, turn cancellation and runtime reload. Current native direct-worker observations still refuse unknown counts; an ambiguous invisible worker may allow later excess. This is an observational boundary, with no hard, cross-process or restart-safe capacity guarantee. No schema, operation or setting was added.
- Count current native direct-worker observations across all task/project statuses, including unrecorded children, instead of requiring every historical worker session to remain readable forever. Preserve append-only history and recent-record visibility grace; missing/deleted rows do not confirm physical termination. Refuse incomplete observation lists and unknown current activity/provenance. Normalize native-trimmed spawn targets for profiles and scoped admission, and share same-process boards by order-independent JSON configuration identity. Native input validation errors still retain unconfirmed custody; bounded observational ordering is not a hard capacity guarantee.
- Serialize engineering's direct configured-worker admission with a board-owned same-process claim held from count through matching accepted-result recording. Concurrent callers receive immediate retry refusal; unknown count state blocks only this spawn, and uncertain launch/recording retains custody across runtime reload with no timeout unlock. Count recorded workers on closed/cancelled tasks, use native parent provenance rather than descendant activity, retain worker keys, and recheck lifecycle/records after native reads. Product/personal work remains outside this gate. Pending custody does not survive process restart; this is not a restart-safe hard cap. No schema, operation or setting was added.
- Revalidate task row facts and latest note identity at commit time after native awaits, preserving newer cancellation and other updates. Retry recorded cancelled workers from existing rows, including late spawn records, without treating unknown liveness as confirmed termination.
- Count only accepted, unchanged-task wakes toward inactivity; failed dispatches retain changes and retry, and late acknowledgements preserve new check-ins. Existing three-idle-wake stalls remain.
- Refuse nonempty schema-zero databases before board DDL, permissions or journal changes. Preserve original delivery destination, operation identity and exact sent text in existing receipt JSON for attachment retries and deferred chat history; uncertain legacy destinations remain visible. No schema, status, tool operation or setting was added.
- Ship a path-explicit SQLite backup and staged verification utility with private snapshots, overwrite refusal and recovery guidance. Verification does not authorize live replacement or qualify full-host/off-host recovery. Worker capacity behavior is unchanged.

## 6.6.4 - 2026-10-05

- The board recovers by itself from a gateway companion that keeps failing. The companion process was already restarted on the next request after a crash, but when restarting did not help (as in the 6.6.1 reload outage) every scan kept failing until someone noticed. When the companion has given no answer for five minutes, the scan now replaces it and the runtime with fresh ones from the current code, logs that it did, and tries again; it repeats after another five minutes if needed.

## 6.6.3 - 2026-10-05

- A plugin reload no longer leaves the board unable to reach the gateway. The board is shared by every registration in the process and survived the reload together with the previous code's companion process and runtime. After the 6.6.1 reload the companion never started again, so for 45 minutes the scan could not see any manager sessions and woke nobody for two new tasks. When a new registration's service starts while an earlier one owns the board, the board now starts over with a new companion and runtime from the new code, so a reload also deploys new runtime code.
- Health reports a scan that could not see a manager's sessions as `lastError` until a scan succeeds. Before, health said `lastError: null` throughout the outage.
- A companion that fails reports why (its exit code or error and the last line of its error output) instead of only "interrupted".

## 6.6.2 - 2026-10-05

Protocol 11.13. Skill only.

- Engineering is encouraged to build developer tooling and skills that help the team work faster and see what it is doing, using what the platform provides first. The stakes rule now concerns only the depth of testing and hardening (reliable in normal use and failing visibly for tooling, rigorous for production code and user data), so it no longer reads as a limit on building tooling.

## 6.6.1 - 2026-10-05

Protocol 11.12. Skill only.

- Engineering gives each worker one bounded job with an assignment that stands alone, like a developer briefing a coding agent: goal and why, the user's relevant direction and standards, whether to change code or only investigate, the files it may change, how to verify, and the short report wanted, with an instruction to stop and report rather than guess or widen the scope. Board, task numbers, managers and profiles stay out of it. A worker sees only the repository and its assignment, and team details would confuse it. The shape follows the subagent guidance of OpenCode's task tool, Codex and Claude Code.
- Lasting standards for how the repository is written or built are recorded in the repository's docs and `AGENTS.md`.
- Project `context` holds lasting facts and the user's direction; status, evidence, hashes and history go in task notes. Context, notes and messages are written in plain sentences.
- Product checks each requested point against the result itself rather than the handover summary, and says which points are only partly done.
- Engineering matches testing and hardening to the stakes: development tooling must work in normal use and fail visibly; production code and user data get adversarial testing.

## 6.6.0 - 2026-10-05

Protocol 11.11.

- Private sessions of closed tasks are kept for seven days, so the work can be reviewed afterwards, and then deleted once idle. Runs in them stay refused. A task reopened within the week continues in its old session.
- Skill: one task per piece of work the user asked for (progress through `notify`, questions on the same task, `check_in_minutes` for watching); lasting user direction is recorded where the next reader finds it (repository docs, project `context` or `USER.md`); status answers cover every open task and limitations are stated once; repository files hold current plain-language instructions while evidence goes in the PR and board notes, and a repository skill is one self-contained folder; engineering reviews worker output for proportion and prefers a simpler design to patching a mechanism; work in progress is pushed early as a draft PR.

## 6.5.4 - 2026-10-04

- Board messages are added to the chat's session from the board service's own async context. Called inside a manager's tool call (or a scan that call requested), OpenClaw's write context for that turn refused the write ("session writer claim changed before transcript persistence"), so in the live run each message was only added by the next periodic scan.

## 6.5.3 - 2026-10-04

- Skill: `view_image` opens only files in the agent's own workspace and OpenClaw's media folders, so agents copy an image from a project checkout or elsewhere into their workspace first. In the live check Jarvis's `view_image` refused a path outside those folders.

## 6.5.2 - 2026-10-04

Protocol 11.10.

- A message that fell back to the owner DM is also added to the DM's session, with the project-name prefix it was sent with. The session is found the same way for both chats: the product manager's one session whose native delivery target is that chat.
- A comment at the transcript append says what to check before raising the pinned OpenClaw version, because its SDK subpath is private-local.

## 6.5.1 - 2026-10-04

Protocol 11.9. Board schema 18: the outbox has a `recorded` column. There is no migration; the operator adds it (`ALTER TABLE outbox ADD COLUMN recorded INTEGER NOT NULL DEFAULT 0`, `UPDATE outbox SET recorded=1`, `PRAGMA user_version=18`).

- A message the board delivers to the project chat is added to the product manager's session for that chat as his own reply: the text, then a `MEDIA:` line per attached file. It uses OpenClaw's transcript writer (`appendSessionTranscriptMessageByIdentity` from the JavaScript-only `plugin-sdk/session-transcript-runtime`) with a stable idempotency key. Native `chat.inject` and delivery copies are display-only and never reach the model; this entry does. The append waits while that session runs a turn and the scan retries it for a day. A failure is logged and never affects delivery. Messages that fell back to the owner DM are not added.
- Attached files are sent with native `message.action` instead of `send`, which wrote a display-only file-name copy into the chat's session.
- Removed the 6.5.0 list of recent board messages from the project chat's context; the session now holds them.
- The native lane also checks that the pinned build exports the transcript writer.

## 6.5.0 - 2026-10-04

Protocol 11.8. Board schema 17: the outbox has a `files` column. There is no migration; an existing schema 16 board is upgraded by the operator (`ALTER TABLE outbox ADD COLUMN files TEXT NOT NULL DEFAULT '[]'`, then `PRAGMA user_version=17`).

- `update_task` messages and `notify` take optional `attachments`: up to four existing files (absolute paths, 8 MB each). The plugin checks them when the message is recorded. It sends them after the text through native `send` to the same chat, each with a stable idempotency key, and reads them again on every attempt. A failed file retries the whole message; the text is not sent twice.
- In a chat a project uses, the product manager's context lists what the board sent there in the last day (up to three messages per project), with file paths. These messages come from private sessions and are not in that chat's history, so follow-up questions can be answered and files opened again.
- Skill: files travel as paths in notes; open each image with `view_image` before acting on it or passing it on, and say what it shows; copy files a worker needs into its worktree; commit a diagram's source next to its rendered image.

## 6.4.2 - 2026-10-03

Protocol 11.7.

- Removed the plugin's failed-worker wake-up (added in 6.3.0). On OpenClaw 2026.9.8, native completion resumes the holder's session when a worker is stopped by a restart. In the live test, the plugin's wake-up only caused a duplicate turn. The holder's check-in remains the fallback.

## 6.4.1 - 2026-10-03

- Cancelling a task stops its workers with `clearQueued`, so follow-ups already queued for them are dropped too.
- Removed the deletion of exported transcript files after cleanup. OpenClaw 2026.9.8 no longer returns `exportedPaths`.

## 6.4.0 - 2026-10-03

Requires OpenClaw 2026.9.8 and Node 24.16+ or 26.1+.

- Private task sessions now end with one short line on what was done, not `NO_REPLY`. From 2026.9.8, internal sessions cannot complete with a silent token. The line is still private: wakes use `deliver:false`, and the send hooks still cancel any user-chat output.
- A worker counts as stopped without finishing when its session ended with any status other than `done`: failed, killed, interrupted or timed out. 2026.9.8 marks restart-interrupted workers `interrupted`, not `failed`.
- The native method check also reads 2026.9.8's `.mjs` chunks and its core method table. CI runs Node 26.8.1.

## 6.3.3 - 2026-10-02

- Skill: after merge or cancellation, engineering also removes the remote branch (`gh pr merge --delete-branch` on merge). Every merged PR in the live test repository had left its branch on GitHub.

## 6.3.2 - 2026-10-02

- A failed worker is timed by its session's `endedAt`, not `updatedAt`. After a restart the host touches the dead row again, which woke the holder a second time in the live test.

## 6.3.1 - 2026-10-02

- The failed-worker wake-up now says "Unless you stopped it". A worker the holder stops himself also ends as failed and causes one wake-up, which should not prompt a re-run.

## 6.3.0 - 2026-10-02

Protocol 11.6.

- A recorded worker whose native session failed after its holder was last woken wakes the holder at the next scan, once per failure: "A worker stopped without finishing". OpenClaw's own completion notice does not always start a turn. In a live restart test, the holder waited 29 minutes for his own check-in. Normal completions are still left to OpenClaw's notice. The scan adds one session list for the worker agent while open tasks have workers.

## 6.2.5 - 2026-10-02

Skill only (protocol 11.5):

- The product manager describes what the user needs and passes technical choices to engineering as questions, even when the user asks it to decide.
- Repository changes describe the product and its technical decisions. Coordination between the managers (who asked, who decided, handovers and corrections) stays on the board.

## 6.2.4 - 2026-10-02

Skill only (protocol 11.4): in a private session a reply without a tool call ends the turn, so managers do the next step instead of announcing it, and end a turn only when the task is handed over or closed, or they are genuinely waiting. After a worker finished, Gilfoyle had replied "I'm checking the implementation…" and stopped until his check-in ten minutes later.

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
