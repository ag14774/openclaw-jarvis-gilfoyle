# OpenClaw Jarvis-Gilfoyle

![Pixel-art Jarvis robot and Gilfoyle engineer flanking a coral claw](assets/logo.png)

A small, personal-use OpenClaw plugin that gives a product-manager agent and an engineering-manager agent a shared SQLite board. Requests, handovers and messages stay on the board; the managers work in private task sessions and delegate implementation to workers.

The names are thematic. Roles use your configured agent IDs. The [repository](https://github.com/ag14774/openclaw-jarvis-gilfoyle) is private and the package is `UNLICENSED`.

## Start here

- **[Getting started](getting-started.md):** install the plugin and configure the three agents.
- **[Workflow](workflow.md):** request work, answer questions and review results.
- **[Board reference](board-reference.md):** all seven tool operations, settings and enforced rules.
- **[Design and boundaries](design.md):** what the board owns and what depends on the trusted host.
- **[Operations](operations.md):** inspect health, stalled work and delivery failures.
- **[Documentation](documentation.md):** build and preview this site locally.

## A board, not another planning framework

Each open task has one holder: product, engineering or the user. A note carries the work to its next holder. A mechanical scan wakes managers when something changed or a check-in is due. Agents interpret the request, choose the engineering approach and review the result.

Private sessions keep task conversations separate from user-facing chats. They are **not a security sandbox**. Use this plugin with cooperative agents on a trusted OpenClaw host, and keep tool permissions and worker isolation in host configuration.

These pages describe the repository's current behavior, not a claim that every live channel or failure scenario has been qualified. See the repository's [testing guide](https://github.com/ag14774/openclaw-jarvis-gilfoyle/blob/main/TESTING.md) for evidence boundaries.
