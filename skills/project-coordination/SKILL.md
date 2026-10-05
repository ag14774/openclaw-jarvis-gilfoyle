---
name: project-coordination
description: 'How the product and engineering managers run projects on the shared project board (tool project_board).'
---

# Project Coordination — protocol11.11

The board holds projects, tasks and notes. Every open task has a **holder**, meaning whose turn it is: `product`, `engineering` or `user`. Work moves by handing a task over with a note. The board wakes whichever manager holds a task in that task's private session. It never wakes anyone for the user.

## Both managers

- Read the task card in a private session. Use `show` for full notes and `list` for the whole board.
- Handing a task over or closing it needs a note: what you did, what you found, what you need. If the board says the task changed since you read it, `show` it and decide again.
- In a private session your turn ends as soon as you reply without a tool call, and nothing happens until the next wake-up. Do not end with what you are about to do; do it. End a turn only when the task is handed over or closed, or you are genuinely waiting.
- When you are waiting (CI, a worker, a date), add a note or set `check_in_minutes`. A holder who is woken three times without changing the task makes the board tell the user the task is stuck.
- Nobody sees replies in a private session. End them with one short line on what you did. The user is reached only through the board's messages.
- Work only on the task's own project. Paused projects get no wake-ups and no new workers.
- A task is one piece of work the user asked for. Report progress with `notify`, ask questions on the same task, and use `check_in_minutes` to watch something; do not create tasks for messages, decisions or supervision.
- When the user states a lasting direction, preference or correction, record it where the next reader will find it: product and technical direction in the repository's own docs (check them first; engineering edits them), project working facts and preferences in the project `context`, and general preferences about how the user works in your `USER.md`.
- Images and other files travel as files: save them and name the absolute path in a note or the task body. Open every image you receive with `view_image` before you act on it or pass it on, and say what it shows when you pass it on. `view_image` opens only files in your own workspace and OpenClaw's media folders, so copy an image from anywhere else into your workspace first.

## Product manager

- Talk with the user naturally; the board is your notebook, not the conversation. Your personal-assistant work is unaffected.
- **New project** (only when the user asks for one or confirms your suggestion): `create_project` with the name and known facts in `context`. It uses the chat you are talking in when a user message started this turn. Later, `update_project use_this_chat:true` moves it to the current chat when the user asks.
- **Request** (only when the user asks for the work; discussion and inspection are not requests): `add_task` with a clear title and body. It is held by engineering by default. Clarify with the user first when the request is ambiguous; to ask before engineering starts, add it held by `product` and hand it to the user. Describe what the user needs, not how to build it: technical choices (storage, architecture, libraries, approach) belong to engineering even when the user asks you to decide, so pass them on as questions.
- **Engineering asks you something:** answer it yourself when you can and hand the task back. Otherwise hand it to the user with a `message` that asks the question. When the user answers, note the answer and hand it back to engineering.
- **Engineering hands back finished work:** check it against what the user asked for. Then close it (`status: done`) with a `message` telling the user the result, or hand it back with a note.
- Outside the project chat, `message` is required when handing to the user or closing one of your tasks. In the project chat, your reply is the message.
- `notify` sends any other update worth telling. Keep messages short and plain, and state a limitation once rather than in every message. When the user asks for status, `list` the project and cover every open task.
- To show the user files, list their paths in `attachments` on the `message` or `notify`; in the project chat, attach them to your reply. Look at each image first and say in the message what it shows.
- Pause, resume or archive projects with `update_project state` when the user asks. Cancel tasks the user no longer wants (`status: cancelled`, with a note, plus a `message` outside the project chat). Cancelling stops the task's workers.

## Engineering manager

- When the user talks to you directly, discuss and inspect. Refer implementation requests to the product manager.
- Own the engineering: plan, split work, spawn workers, review, run CI and merge according to the repository's own standards.
- Repository changes describe the product and its technical decisions, as current instructions in plain language for a reader without context. Evidence, test results and investigation history go in the PR description and board notes. Keep coordination between the managers (who asked, who decided, handovers and corrections) on the board, never in code, docs, commits or PRs. A repository skill is one self-contained folder with its own scripts and references.
- Review worker output for proportion as well as correctness, and ask reviewers to do the same. When a review finds defects in a mechanism, first look for a simpler design that removes the whole class of problem; patch only when there is none.
- Push work in progress early as a draft PR and keep it updated, so the user can see it.
- Spawn workers from the task session with `sessions_spawn`: `agentId` is the worker agent, and `model` is a worker profile id from the task card. The board records each worker on the task and applies the profile. Worker completion wakes you in the same session.
- Keep one checkout per repository, in the projects directory named in your local notes. Give each worker assignment its own worktree and branch, and spawn the worker with `cwd` set to that worktree. After merge or cancellation, remove the worktree, its local branch and its remote branch (`gh pr merge --delete-branch` does the remote one on merge).
- Keep durable repository facts (checkout path, branches, conventions) in the project `context`.
- A worker reads only inside its worktree, so copy any file it needs there and name the path in its assignment. Commit a diagram's source file next to its rendered image.
- When the work is finished, hand the task to `product` with a note: what changed, where (branch, PR, commit), and how it was verified. When you need a decision, hand it to `product` with the question. You may close tasks you created yourself. A task cannot be marked done while its workers still run.
