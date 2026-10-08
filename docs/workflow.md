# Normal workflow

## Request, work, review

1. **Start in the project chat.** Ask product to create a project. Its context holds lasting facts, repository locations and your direction. Creation binds the current user-message chat when available.
2. **Request a piece of work.** Product records a task with a clear title and body, held by engineering by default: one task per separate feature or unrelated ask. Discussion alone is not a request to implement.
3. **Let engineering work.** Engineering reads the task in its private session, settles a short design and keeps the steps in the task's plan, shown at the top of the task card. It runs independent steps in parallel workers, reviews the results with the `code-review` skill and hands the same task back with a note. A task too large for one session goes back to product with a proposed split.
4. **Answer questions on that task.** Product hands it to the user with a message if input is needed. Your answer is recorded in a note and handed back to engineering; no separate task is needed for the question.
5. **Review and finish.** Product checks each requested point against the result itself, closes the task and tells you what changed or what remains incomplete.

These are the bundled skill's working practices. The board mechanically requires notes on handovers and closing, but it does not inspect the quality of a review, run CI or verify a merge.

## Progress and waiting

Use `notify` for useful progress updates. Notes hold status and evidence; project context holds durable facts, not a running log. One task represents one requested piece of work, not every message or supervision step.

The scan runs every **60 seconds** by default. It wakes the manager holding a changed task or a due check-in, normally **60 minutes**, without interrupting a session reported as mid-turn. A private reply ends the turn; saying what will happen next does not continue execution. Managers should act, hand over, or explicitly record what they are waiting for and set `check_in_minutes` when needed.

Tasks held by the **user** get no automatic wake-ups. After three unproductive wakes with no running workers, the board queues a stall notice and stops automatic wakes until a task update resets the stall. Check [operations](operations.md) if work goes quiet.

## Chats and models

Ask product to move the project to the current chat when needed; `update_project` with `use_this_chat: true` binds only the chat of the user message that started that turn. Delivery fallback never moves that binding.

Select `/model` and `/think` in the project chat for both managers' private task sessions. The plugin reads those settings at each wake; otherwise agent defaults apply. A settings-copy error is logged and execution proceeds. Worker models come from configured worker profiles, separately from the managers' chat choice.

## Pause or cancel

- **Pause the project:** stops automatic wakes and new worker spawns, but existing workers continue.
- **Resume:** prompts holders of open tasks to look again.
- **Cancel a task:** closes it with a note and aborts its recorded workers, clearing queued follow-ups.
- **Archive the project:** requires all tasks to be closed or cancelled.

Closed-task manager sessions remain for seven days and are then removed once idle. The persistent board is separate from those sessions. See the [board reference](board-reference.md#enforcement) for exact role and lifecycle checks.
