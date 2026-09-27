---
name: project-coordination
description: 'Durable projects, scoped engineering, decisions and receipt-backed communication.'
---

# Project Coordination — protocol7.0

Agents decide what work means, how to decompose it, whether workers are useful, which checks matter, what conclusions follow and what to tell the user. The plugin validates identity, authority, relationships, execution evidence, external effects and delivery. Do not invent semantic request or outcome categories.

Load this skill when project operations are needed and consume the returned contents. In Code Mode, use `return await skills.read('project-coordination');` and read its result. The plugin supplies your project role and your counterpart's display name and agent ID in runtime context. Use agent IDs for routing; names are presentation, not authority. The literal tool names `jarvis_project` and `gilfoyle_engineering` are API identifiers independent of agent names.

Project identity, routes, repositories and coordination checkpoints live in the registry. Workboard owns human-visible engineering obligations, ownership, status, conclusions and proof. Native tasks own execution liveness; Git and hosting providers own repository effects. Card notes are natural human context and are never a machine protocol.

## Responsibility

The product manager owns product understanding, priorities, lifecycle and normal user communication. The engineering manager owns engineering judgment, delegation, verification and publication. Routine choices stay with the agents. The user retains new direction, material architecture/security/spending changes, unusual risk and production approval.

Accept natural requests. Investigation is not permission to modify. Record accepted work before claiming acceptance; distinguish durable intake from execution. Ask only when intent, authority or relevant project is genuinely uncertain.

Internal contexts are scoped to one registry Feature. They must not mutate another Feature or read personal/unrelated histories. Same-Feature private consultation may use `sessions_send`; it does not transfer authority or replace durable records. Internal turns end `NO_REPLY`.

## Project Operations

Invoke `jarvis_project` with `{operation,input}`. Channel-bound operations carry the current-turn `sourceToken`; never invent one.

| Operation          | Input                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `declare`          | `{name,purpose,explicit:true,conversationRef?}`                                                             |
| `context`          | `{projectId,context,revision}`                                                                              |
| `move`             | `{projectId,explicit:true,revision,conversationRef?}`                                                       |
| `associate`        | `{projectId,explicit:true,repository:<repository fields>}`                                                  |
| `intake`           | `{projectId,title,scope,authorized:true,boards?,requestKey?}`                                               |
| `amend`            | `{projectId,boardId,featureId,expectedUpdatedAt,expectedRevision,scope,reason,authorized:true}`             |
| `priority`         | `{projectId,priority}`                                                                                      |
| `control`          | `{projectId,featureId,requestId?,kind:"stop",reason,explicit:true}`                                         |
| `schedule`         | `{projectId,title,scope,boards?,next,intervalMs?,authorized:true}`                                          |
| `schedule-disable` | `{projectId,id}`                                                                                            |
| `inactivate`       | `{projectId,revision,confirmed:true,dispositions:{id:"finish"                                               | "stop" | "pending"}}` after fresh inventory |
| `reactivate`       | `{projectId,explicit:true}`                                                                                 |
| `recover`          | `{projectId}`; operator calls may reset unchanged retry exhaustion, agent calls request reconciliation only |

Repository fields are `{architectureDocs,checkout,evidence,integrationBranch,name,productDocs,readiness,repository,requiredCI,scope}`. Verify effective fetch/push destinations and usable checkout. Supported publication adapters are GitHub HTTPS `.git` and local `file:` remotes. Missing setup blocks execution, not declaration or durable intake.

One intake creates one registry request and one board-local Feature per selected repository. Registry Feature IDs, obligation IDs, request IDs, card IDs and delivery IDs are distinct; use the exact returned field expected by each operation. Notes remain natural scope/context and may be reformatted without changing identity.

## Communication

The product manager authors user-facing prose from durable facts. Native sent receipts establish delivery.

- `notify`: `{projectId,featureId,event,kind,message,fallbackMessage?}` for nonterminal useful updates. Terminal `result:*` events are created only by terminal checkpoints.
- `communication-decision`: `{projectId,event,notify,reason,message?,fallbackMessage?}`. A terminal result intent must be composed, not dismissed.
- `milestone-decision`: `{projectId,featureId,event,notify,reason,message?}`.
- `delivery`: `{projectId,id}` returns retained status and receipt.
- `question-delivery`: `{projectId,checkpoint,message,fallbackMessage?}` sends the retained decision question once.
- `answer`: `{projectId,checkpoint,answer,correlated:true}` records an authentic user answer.
- `also-notify`: `{projectId,featureId?,event,explicit:true,conversationRef?}` adds an event copy without rebinding.
- `conclude`: `{projectId,conclusion}` records an internal checkpoint; it is not Feature completion.

Nearby milestones may coalesce. Fallback never rebinds. Reuse operation identity after uncertainty; never rekey or resend merely to repair bookkeeping.

## Engineering Operations

Invoke `gilfoyle_engineering` with `{operation,input}` from the registered Feature context. Read-only `profiles` and `workboard-query` are available to managers. Engineering mutations are restricted to the context's exact Feature.

| Operation                  | Input                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `work-item`                | `{assignment,boardId,featureId,requires,scope,title,context?,required?}`                                                  |
| `review`                   | `{boardId,featureId,reviewKey,candidate,requires,scope,title,context?,required?}`                                         |
| `exceptional-intervention` | `{boardId,featureId,kind,reason,title,context?,required?}` only for actual owned work                                     |
| `profiles`                 | `{}`                                                                                                                      |
| `workboard-query`          | `{agentId,boardId?,tenant?,includeArchived,view?,after?,membership?}`; `tenant` is registry Feature ID or Feature card ID |
| `handoff`                  | `{boardId,id                                                                                                              | obligationId,checkpoint?,expectedUpdatedAt?,decisionBy:"user" | "agent",reason,question,resolution}` |
| `decide`                   | `{checkpoint,decision,evidence,expectedUpdatedAt?}` for agent-authorized decisions                                        |
| `handoff-apply`            | `{checkpoint,application,replacementRequired,expectedUpdatedAt?}`                                                         |
| `settle-control`           | `{boardId,controlId}` after exact execution/effects reconcile                                                             |
| `finalize`                 | `{boardId,featureId,summary,evidence,sha?}` for truthful settled nonpublication outcomes                                  |

Use meaningful native Workboard states. `triage` needs judgment; `backlog`/`scheduled` defer; `todo`/`ready` are open; `review` awaits verification; `blocked` retains a hold; `done` is settled only with the required terminal checkpoint. Status is not worker liveness.

### Delegation

Create a distinct registered worktree/branch at immutable base HEAD before each implementation/review attempt. Query attention and complete capacity first.

`prepare` input is `{boardId,id|obligationId,attempt,taskName,profileId,timeoutSeconds,baseSha,worktree,branch,replaces?,remaining?,reconciliation?,candidate?}`. It returns `attemptId`, profile and `spawnArgs`. Use returned arguments exactly; ordinary implementation task text may append the agent-authored assignment. Review task text is already exact and read-only.

After accepted `sessions_spawn`, call `record` with `{boardId,id|obligationId,attemptId,runId,childSessionKey,taskId,wrapperTaskId}`. Binding is bookkeeping, not permission. Exact native task/runtime/agent/owner/session/run markers must match. Unique missing bindings may reconcile automatically; ambiguity never authorizes another worker.

Replacement attempt N+1 uses `replaces:<prior attemptId>`, a new worktree/branch, free-form `remaining` and `reconciliation`, and requires exact prior tasks terminal plus the worker session inactive. Preserve valid effects; do not discard or use stash-only transfer.

### Decisions And Stops

Handoffs are registry decision checkpoints; Workboard owner/status is a human projection. Use `decisionBy:"user"` for retained user authority and `agent` when established direction authorizes judgment. Reasons, questions, resolutions, decisions, evidence and applications are free-form bounded text. Answered decisions return next action to engineering durably.

`control` records stop intent without creating a card. Stop new work, reconcile exact tasks/sessions and publication effects, then use `settle-control`. Create an intervention Work item only if actual engineering work is required.

### Completion And Publication

Required obligations must be done with passed proof and all registered attempts bound and terminal. `finalize` accepts any truthful settled outcome; a passed terminal proof verifies the conclusion, not that failed work succeeded.

GitHub flow:

1. `publish-gate` with `{boardId,featureId,sha,reviewId,summary,hosted:{headRef,baseSha}}` validates exact reviewed candidate before upload.
2. Push exact candidate, create/reconcile one same-repository PR.
3. `gate` adds `prNumber`; it verifies exact candidate CI and stores a continuation checkpoint. A returned CI wait is durable; release claims while waiting.
4. Merge conditionally using the repository-supported strategy.
5. `finish` with the identical candidate/review/hosted identity revalidates the passed gate and actual merge.

Local publication uses `gate`/`finish` without `hosted`. Helpers validate but never push, create PRs or merge.

Terminal facts and a held result communication intent are staged before native Feature completion. Once completion is confirmed, the product manager receives the intent and authors the result. There is no notification card. A manually done Feature without its completed terminal checkpoint remains actionable, never silently accepted.

## Recovery

The shared scanner joins registry relationships, Workboard state, native tasks/sessions and delivery receipts. It ignores unregistered cards and never parses notes for identity. Staged native creation, scope projection, decision ownership, execution binding, publication, terminal completion and result communication are idempotently reconciled.

Retry budgets apply only to unchanged attention state and reset on durable progress. Exhaustion creates one product communication intent rather than silently stranding work. Do not create project heartbeats or competing schedulers. Preserve credentials, personas, personal schedules and unrelated state.
