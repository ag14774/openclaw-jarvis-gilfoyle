---
name: code-review
description: "How to review a change (PR, branch or diff) and how to act on review findings: the repository's own rules first, findings rated by how likely and costly they are where the code runs, smallest fixes including deletion, size, and a short report with a clear verdict. Use when asked to review code, and when deciding what to do with review findings."
---

# Code review

## The repository's rules come first

Before anything else, read the repository's `AGENTS.md` and any standards it points to; managers also read the project context. They override every default in this skill, and you must apply them strictly. For example, when the repository says it has a single installation and wants no compatibility code, backward compatibility is not a requirement and compatibility code is a defect to remove. The defaults below apply only where the repository says nothing.

## Reviewing a change

You need what was asked and why, the diff range (base and head), the repository's standards, and the facts about where the code runs. When a finding depends on a fact you do not have, say so instead of assuming the worst.

1. Read the standards and the request, then the whole diff (`git diff --stat base...head`, `git diff base...head`). Stay read-only on the checkout; look at other revisions in a separate worktree.
2. Against the request: requirements missing or only partly done; behaviour nobody asked for; options, abstractions or hooks for needs nobody has. Propose removing what was not asked for.
3. Correctness in normal use: bugs, lost or corrupted data, work that can get stuck, security exposure, changed behaviour without a test, docs that no longer match the code.
4. Default: existing data, configuration and callers keep working (backward compatibility), unless the repository says otherwise.
5. Rate every finding by how likely it is in normal use where this code runs, and what it costs when it happens:
   - **Blocking:** plausible in normal use, with a real cost.
   - **Should fix:** real, but unlikely or cheap when it happens.
   - **Note:** polish, style, or a case that is only theoretical here.

   Races that need unusual timing, hostile input on a trusted host and states the code cannot reach are notes, not blocking.

6. For each finding give the file and line, what is wrong, why it matters here, and the smallest fix. Removing code or a whole mechanism counts and is often the best fix. When several findings come from one mechanism, say so and suggest a simpler design rather than patches.
7. Size: lines added and removed, and whether that is proportionate to what was asked.
8. Do the review yourself; do not start other reviewers or sub-agents.

Report in about 400 words or fewer:

- **Verdict:** merge, merge after the blocking fixes, or redesign, with one line of reasoning.
- **Blocking**, **Should fix** and **Notes**, each finding with file:line and the smallest fix.
- **Size:** the line change and whether it is proportionate.
- **Set aside:** anything you considered and did not judge, with the reason.

## Acting on findings

1. Check each finding against the real code, its actual use and the facts about where it runs before changing anything. The reviewer may lack context: is the case reachable, and is the code it wants hardened actually used?
2. Fix blocking findings with the smallest change, deletion included. Decide should-fix findings and notes by their cost, and record the ones you skip and why.
3. Push back, with reasons, on findings that are wrong for this repository or conflict with its rules.
4. A finding that conflicts with a decision the owner made goes back to the owner, not into code.
5. Review again after fixing blocking findings. Fixes for should-fix findings and notes, and other small follow-ups, need only your own check of the diff and the tests. Any number of rounds is fine while the fixes stay proportionate. When a second round still finds new blocking defects in the same mechanism, stop patching: redesign that mechanism more simply.
