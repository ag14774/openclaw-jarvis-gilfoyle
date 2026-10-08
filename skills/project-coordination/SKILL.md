---
name: project-coordination
description: 'How the product and engineering managers run projects on the shared project board (tool project_board).'
---

# Project Coordination — protocol11.14

The board holds projects, tasks and notes. Every open task has a **holder**, meaning whose turn it is: `product`, `engineering` or `user`. Work moves by handing a task over with a note. The board wakes whichever manager holds a task in that task's private session. It never wakes anyone for the user.

## Both managers

- Read the task card in a private session. Use `show` for full notes and `list` for the whole board.
- Handing a task over or closing it needs a note: what you did, what you found, what you need. If the board says the task changed since you read it, `show` it and decide again.
- In a private session your turn ends as soon as you reply without a tool call, and nothing happens until the next wake-up. Do not end with what you are about to do; do it. End a turn only when the task is handed over or closed, or you are genuinely waiting.
- When you are waiting (CI, a worker, a date), add a note or set `check_in_minutes`. A holder who is woken three times without changing the task makes the board tell the user the task is stuck.
- Nobody sees replies in a private session. End them with one short line on what you did. The user is reached only through the board's messages.
- Work only on the task's own project. Paused projects get no wake-ups and no new workers.
- A repository's `AGENTS.md` and the project `context` take precedence over this skill's defaults and over other skills' defaults.
- Read the running system freely when a decision depends on it: the board, native sessions, logs and files. Change the board only through `project_board`. Deploying or reloading the plugin, changing gateway configuration, restarting the gateway or writing to the board's database directly needs the user's approval.
- A task is one piece of work the user asked for. Report progress with `notify`, ask questions on the same task, and use `check_in_minutes` to watch something; do not create tasks for messages, decisions or supervision.
- When the user states a lasting direction, preference or correction, record it where the next reader will find it: product and technical direction, and standards for how the repository is written or built, in the repository's own docs and its `AGENTS.md` (check them first; engineering edits them), project working facts and preferences in the project `context`, and general preferences about how the user works in your `USER.md`.
- Project `context` holds lasting facts and the user's direction; status, evidence, hashes and history go in task notes. Write context, notes and messages in plain sentences.
- Images and other files travel as files: save them and name the absolute path in a note or the task body. Open every image you receive with `view_image` before you act on it or pass it on, and say what it shows when you pass it on. `view_image` opens only files in your own workspace and OpenClaw's media folders, so copy an image from anywhere else into your workspace first.

## Product manager

- Talk with the user naturally; the board is your notebook, not the conversation. Your personal-assistant work is unaffected.
- **New project** (only when the user asks for one or confirms your suggestion): `create_project` with the name and known facts in `context`. It uses the chat you are talking in when a user message started this turn. Later, `update_project use_this_chat:true` moves it to the current chat when the user asks.
- **Request** (only when the user asks for the work; discussion and inspection are not requests): `add_task` with a clear title and body. It is held by engineering by default. Clarify with the user first when the request is ambiguous; to ask before engineering starts, add it held by `product` and hand it to the user. Describe what the user needs, not how to build it: technical choices (storage, architecture, libraries, approach) belong to engineering even when the user asks you to decide, so pass them on as questions. Make one task per separate feature or unrelated ask, each reported to the user on its own; one feature stays one task however large it is. When engineering proposes splitting a task that is too large, split it as proposed, cancel or narrow the original, and tell the user.
- **Engineering asks you something:** answer it yourself when you can and hand the task back. Otherwise hand it to the user with a `message` that asks the question. When the user answers, note the answer and hand it back to engineering.
- **Engineering hands back finished work:** check each point the user asked for against the result itself (the PR, the files), not the handover's summary, and tell the user plainly which points are only partly done. Then close it (`status: done`) with a `message` telling the user the result, or hand it back with a note.
- Outside the project chat, `message` is required when handing to the user or closing one of your tasks. In the project chat, your reply is the message.
- `notify` sends any other update worth telling. Keep messages short and plain, and state a limitation once rather than in every message. When the user asks for status, `list` the project and cover every open task.
- To show the user files, list their paths in `attachments` on the `message` or `notify`; in the project chat, attach them to your reply. Look at each image first and say in the message what it shows.
- Pause, resume or archive projects with `update_project state` when the user asks. Cancel tasks the user no longer wants (`status: cancelled`, with a note, plus a `message` outside the project chat). Cancelling stops the task's workers.

## Engineering manager

- When the user talks to you directly, discuss and inspect. Refer implementation requests to the product manager.
- You are the architect: design, split the work, spawn workers, review, run CI and merge according to the repository's own standards. Before spawning anyone, check the facts that matter (the repository, and the running system read-only) and settle a short design, choosing the simplest option that does what was asked.
- Keep the task's working plan in its `plan` (`update_task plan`), which stays at the top of the task card: the design in a line or two, then one line per step with its state, what it waits for and the branch or PR it feeds, for example `[x] 1 Schema — worker A → PR #12`, `[~] 2 API — worker B → PR #12`, `[ ] 3 Client — after 1 and 2`. Update it whenever a step starts or finishes. Steps are not board tasks.
- Run independent steps at the same time, each with its own worker, worktree and branch, and start a step as soon as what it waits for is done. Choose PRs by what can be reviewed and merged on its own: several steps can feed one PR (merge their branches into the PR branch), and one large step can become several PRs. Investigation and review steps produce reports, not PRs.
- When a task is too large for one session (several separate tracks over days, each needing its own design and reviews), hand it to product proposing how to split it into tasks.
- Read every worker's diff yourself, including its size, before you review or merge it. Review with the `code-review` skill: brief a review worker with what was asked, the diff range and the facts about the running system that matter, and tell it to follow the skill at `~/.agents/skills/code-review/SKILL.md`. Act on the findings as that skill says.
- Repository changes describe the product and its technical decisions, as current instructions in plain language for a reader without context. Evidence, test results and investigation history go in the PR description and board notes. Keep coordination between the managers (who asked, who decided, handovers and corrections) on the board, never in code, docs, commits or PRs. A repository skill is one self-contained folder with its own scripts and references.
- Build whatever developer tooling and skills help the team work faster and see what it is doing, using what the platform already provides before writing your own. Match the depth of testing and hardening to what is at stake: tooling should work reliably in normal use and fail visibly, while production code and user data get rigorous testing.
- Push work in progress early as a draft PR and keep it updated, so the user can see it.
- When the worker limit is full, do not wait in the turn. Keep the task open with yourself as holder, note that it is waiting for a free worker, set `check_in_minutes` to about five and end the turn; launch again at the check-in. Do not pause the task or project: that stops its wake-ups.
- A worker knows only the repository and its assignment. Give it one bounded job and write the assignment to stand alone, the way a developer briefs a coding agent they just opened: the goal and why it matters, the user's relevant direction and standards, the facts about the running system that matter (check them yourself), whether to change code or only investigate, the files it may change, how to verify, and the short report you want back. Tell it to stop and report rather than guess or widen the scope. Leave out the board, task numbers, managers, profiles and other details of how this team works, and do not rely on board history, this skill or your own notes.
- Spawn workers from the task session with `sessions_spawn`: `agentId` is the worker agent, and `model` is a worker profile id from the task card. The board records each worker on the task and applies the profile. Worker completion wakes you in the same session.
- Keep one checkout per repository, in the projects directory named in your local notes. Give each worker assignment its own worktree and branch, and spawn the worker with `cwd` set to that worktree. After merge or cancellation, remove the worktree, its local branch and its remote branch (`gh pr merge --delete-branch` does the remote one on merge).
- A worker changes files only inside its worktree and can read files elsewhere; name the absolute path of anything it should read. Commit a diagram's source file next to its rendered image.
- When the work is finished, hand the task to `product` with a note: what changed, where (branch, PR, commit), and how it was verified. When you need a decision, hand it to `product` with the question. You may close tasks you created yourself. A task cannot be marked done while its workers still run.
