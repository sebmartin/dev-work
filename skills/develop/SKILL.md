---
name: develop
description: The general-purpose dev-work workflow. Takes a ticket or a thread todo from plan to a reviewed pull request, with you as orchestrator. Use when the user types /dev-work:develop or asks to develop a task with dev-work, and when they say a dev-work PR has been merged.
---

# dev-work: develop

Plan → implement → pr-review, ending at a PR whose review meets the bar. Read `../../shared/orchestration.md` first.

## 1. plan

Run `dev-work:plan` with `{ repo, runDir, scopeFile, planFile, failureReport? }`.
Accept if `open` and `new_problems` are empty. Otherwise rule on each: accept with a ruling, or fail (design) if the design is wrong.

## 2. implement

Run `dev-work:implement` with `{ repo, runDir, planFile, globalConstraints, startTask: 1, taskCount }`.
- `needs_orchestrator`: answer the coder's question from the plan, scope or thread, or make the call and record it; re-run from that task with `answers`. If only the user can answer, fail (design).
- `done`: rule on each parked finding: park it with a ruling, or fail (design). A stated reason is not evidence.
- `failed`: fail (operational).

Then read the commit messages before anything is pushed.

## 3. pr-review

Run `dev-work:pr-review` with `{ repo, runDir, planFile, scopeFile, baseSha, branch, baseBranch, repoSlug, title, prNumber? }`.
- `ready`: record the PR, follow-ups and refuted blockers; report success.
- `blocked_at_cap`: fail with the open blockers.
- `failed`: fail (operational).
