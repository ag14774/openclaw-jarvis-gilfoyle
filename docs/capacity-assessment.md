# Worker capacity assessment (read-only)

[Back to README](../README.md)

**2026-10-07.** Inspected this checkout's plugin 6.6.4 source and the locally
installed, lockfile-pinned `openclaw@2026.9.8` npm distribution and bundled docs.
`npm ci` installed only checkout-local locked dependencies and built `dist/`.
No deployed configuration, gateway, workers or provider were accessed. This is
source evidence, not live capacity qualification or a changed capacity promise.

## Procedure first

Cooperative managers should launch one worker at a time: inspect current native
liveness and recorded board workers, await the complete spawn result and board
recording, then inspect again before the next launch. Avoid parallel tool batches
and coordinate launches across task sessions, not merely within each conversation.
Unknown/failed startup or stop acknowledgements require native-state inspection
before replacements. This is the smallest immediate mitigation to evaluate.

Serialization by one caller reduces overlapping launches; it **does not prove a
global hard limit**. Independent task sessions can still launch together; native
inspection and spawn are separate operations; restarts, late recording and hooks
failing open remain boundaries. No skill/procedure or limit setting was changed
in this assignment, and the promised bound has not been weakened by engineering.

## Exact plugin boundaries

- `src/runtime.ts:982–998`: `beforeToolCall` counts native-live **recorded** workers
  on **open tasks**, filtered by configured worker-agent key prefix, then returns
  rewritten spawn parameters. It does not reserve anything. Two callers observing
  `limit - 1` may both pass before either spawn is recorded.
- `src/index.ts:after_tool_call` records `details.childSessionKey` only after
  `sessions_spawn` returns; `src/runtime.ts:751–760` appends it to the task,
  retaining at most the last 50 worker entries. `liveWorkers` (`725–742`) counts
  new records during a grace interval and otherwise uses native session liveness.
- The profile/count check applies only to the configured worker agent, with
  profiles, inside a private task session. Other agents, unrecorded spawns,
  workers recorded only on closed tasks and nested OpenCode work are not that
  count's domain. Hook errors fail open (`src/index.ts` / board reference).
- `worker.limit` defaults to 2, range 1–20 (`src/topology.ts`, manifest).
  `maxWakesPerRole` bounds manager wakes, not worker admission. An empty-board
  sequential test proves refusal once recorded/live workers reach the limit,
  not atomic admission under concurrent callers.

## Native admission and execution limits in the pin

Evidence paths below are relative to `node_modules/openclaw/`; hashed distribution
filenames belong specifically to 2026.9.8. Source-region comments identify their
original modules. Do not infer these boundaries from docs for another release.

| Mechanism                          | Evidence and actual boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary native subagent execution | `docs/tools/subagents/operations.md:11–37,163–170`: `agents.defaults.subagents.maxConcurrent` (default 8) is **per immediate spawning/controller session**. Accepted excess runs queue. Independent sessions have independent budgets; nested children use their own controller budget. Swarm has a separate group lane/cap. This is not total Gateway or board concurrency. `dist/command-queue-Bf07l33f.mjs` implements scoped `subagent:*` lanes.                                                                                            |
| Native child admission             | `dist/spawn-thread-binding-CC3RQjiW.mjs:176–204,334–359` (`child-admission.ts` / `spawn-plan.ts`): `maxChildrenPerAgent` defaults to 5 and checks active children **per requester session**, not target agent or all board tasks. Pending admission is a synchronous process-global map keyed by **controller session**, released after registration or on pipeline exit (`runSpawnPipeline`). This closes overlapping pending admissions within that native scope, not all board sessions.                                                     |
| ACP envelope gating                | `dist/acp-spawn-CbYkT9pC.mjs:1172–1192,1453–1464`: ACP child admission/reservation is enabled only when `isSubagentEnvelopeSession(requesterInternalKey)` is true. `dist/subagent-capabilities-C-BoOoUd.mjs:288–300` recognizes native subagent keys and stored ACP/dashboard envelopes, not arbitrary private namespace keys. The board's `agent:<manager>:jarvis-gilfoyle:task-…` keys (`src/topology.ts:66–84`) are not these envelopes, so that ACP path does **not** establish `maxChildrenPerAgent` admission for board-manager launches. |
| ACP global-session setting         | `acp.maxConcurrentSessions` appears in `dist/legacy-BsVKffEe.mjs:2640` within `RETIRED_TUNING_PATHS`; `stripRetiredTuningKnobs` (`2889–2896`) removes it with “built-in defaults now apply.” It is not an available capacity setting in this pin. Searching the distribution for that field found only retirement copies, no admission implementation.                                                                                                                                                                                          |
| ACP manager                        | `dist/manager-B85OKKGa.mjs:2598–2617,2685+` serializes lifecycle/turn work by the target session actor. The inspected ACP spawn/manager/runtime path supplied no board-wide configured-worker admission cap. A per-session actor is not a cross-session worker counter. No conclusion is made about external backend/provider limits, installed ACP plugin configuration or OpenCode descendant limits.                                                                                                                                         |

## Smallest alternatives and recommendation

1. **Evaluate cooperative serialize-launch procedure first.** It is the least
   invasive operational mitigation, with the boundaries above explicitly retained.
   It is not sufficient evidence for a hard spending/capacity guarantee.
2. **Reuse native limits where their scope matches the requirement.** Native
   per-session subagent execution/admission can bound that session; the inspected
   ACP route and multiple board task sessions do not give a shared board limit.
   Switching runtime or changing native settings changes behavior and needs a
   separate decision. The retired ACP knob is not a solution.
3. **If a stronger cooperative plugin bound is requested**, the smallest code
   candidate is shared in-process serialization covering the whole
   check → native launch → record interval, followed by refreshed liveness.
   Locking only `beforeToolCall` ends too early. Failure cleanup and late/unknown
   results would need explicit verification. It cannot be sold as durable/global
   admission across restarts, independent processes, bypasses or descendants.
4. **If a strict global bound is required**, first define the unit (top-level
   workers, executing turns, adapter processes or descendants), ownership scope
   and failure/restart semantics. The inspected native mechanisms do not supply
   the existing board-wide ACP bound. A broader shared admission mechanism or
   external execution boundary would require separate approval and design evidence;
   a durable reservation/lease scheduler is not justified as the default fix.

Recommendation: procedure-first evaluation, then an explicit owner decision if a
hard bound remains required. Stop at that boundary; no worker behavior, runtime,
skill, setting, schema or spending promise is changed here. Source inspection
does not qualify concurrent live launches, provider billing or restart recovery.
