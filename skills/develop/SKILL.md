---
name: develop
description: The general-purpose dev-work workflow. Takes a thread todo with an approved design from plan to a locally reviewed pull request, with you as orchestrator. Use when the user types /dev-work:develop or asks to develop a task with dev-work, and when they say a dev-work PR has been merged.
---

# dev-work: develop

Plan → implement → review → publish, starting from an approved design. Read `../../shared/orchestration.md` first.

## 1. plan

Run `dev-work:plan` with `{ thread, repo, runDir, designFile, planFile, failureReport? }`.
Check the plan the way the user would glance at it: does its summary match the design, and are its assumptions acceptable? Record its follow-ups. If it misreads the design, fail (design).

## 2. implement

Run `dev-work:implement` with `{ thread, repo, runDir, planFile, globalConstraints, startTask: 1, taskCount }` (`globalConstraints` from the plan, empty if none).
- `needs_orchestrator`: answer the coder's question from the design or the thread, or make the call and record it; re-run from that task with `answers`. If only the user can answer, fail (design).
- `done`: rule on each parked finding: park it with a ruling, or fail (design). A stated reason is not evidence.
- `failed`: fail (operational) with its reason.

## 3. review

Run `dev-work:review` with `{ thread, repo, runDir, designFile, planFile, baseSha, branch, title }`. Everything stays local.
- `ready`: record its follow-ups and refuted blockers.
- `blocked_at_cap`: fail with the open blockers.
- `failed`: fail (operational) with its reason.

## 4. publish

The one step that leaves the machine, done by you. Read the commit messages and the PR description it drafted (`pr_body_file`), then push the branch and open the PR into the target branch with that description. Record the PR in the todo, set Phase to ready, and report: the PR link, a line per task, rulings, follow-ups. The user skims and merges by hand.
