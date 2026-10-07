# Design and trusted-host boundaries

## Small durable records

The plugin keeps projects, tasks, append-only notes and an outbox in SQLite. An open task's holder says whose turn it is. Free text remains free text: the agents interpret context, questions and results rather than the plugin parsing them into another workflow state machine.

| Surface                  | Responsibility                                                               |
| ------------------------ | ---------------------------------------------------------------------------- |
| Board                    | Project context, chat binding, task holder/status, notes and queued messages |
| OpenClaw                 | Native sessions, liveness, tools, providers, channels and delivery receipts  |
| Agents and bundled skill | Intent, planning, delegation, technical choices, review and wording          |
| Repository and hosting   | Code, repository standards, CI, merges and publication effects               |

Mechanical checks stay close to the facts already available: roles, project scope, required notes/messages, worker limits and no completion while workers run. The board does not prove an implementation is correct or that a claimed publication occurred.

## Cooperative agents on a trusted host

Private task sessions are a coordination role, **not hostile multi-tenant containment**. They suppress intentional user-chat replies and scope board operations to the task's project. Task-session `sessions_send` is restricted to that task's workers and direct `message` calls are refused.

Hook errors are normally logged and ignored. Engineering's direct configured-worker admission instead refuses unknown state and holds a same-process gate through matching accepted-result recording; uncertain results can strand it, and process restart loses pending custody. It is not a restart-safe hard cap. Profiles apply to the configured worker agent; this admission gate and limit exclude product/personal launches and descendants. See the [worker guard boundaries](board-reference.md#worker-and-messaging-guards). Outside board operations and private-session guards, the product manager's personal-assistant work and other agents are unaffected.

Host tool permissions, credentials, filesystem access and worker isolation remain OpenClaw/operator responsibilities. Cooperative workers can share the host's credential and failure boundary. Use separate containment for untrusted code; a private session name cannot supply it. Production and spending decisions are not plugin-enforced approval gates.

## Delivery and storage limits

Required user messages are queued with their board change. Delivery uses native idempotency identities, finite retries and the owner-DM fallback. This improves coordination but is not an unconditional delivery guarantee: messages can fail, and a successful send does not prove the user read it.

Attachments are existing absolute-path files, up to four per message and 8 MB each, read again for each attempt. Only select files intended for the recipient and keep them available until delivery finishes. Delivered text and file references are appended to the product manager's chat transcript; a failed transcript append does not undo delivery.

The board uses SQLite WAL, full synchronous writes and foreign keys. New parent directories are created with mode `0700` and the database file is set to `0600`; this is not encryption or a substitute for host access control. Board content, transcripts and attachments can contain sensitive project data. Keep them in the trusted environment and out of repository documentation and site artifacts.

See [enforcement](board-reference.md#enforcement) for the full contract and [operations](operations.md) for visible failure modes.
