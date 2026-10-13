---
name: develop
description: The general-purpose dev-work workflow. Takes a ticket URL or a thread todo from plan to a reviewed pull request, with you as orchestrator. Use when the user types /dev-work:develop or asks to develop, build or implement a task with dev-work. Also use when the user says a dev-work PR has been merged.
---

# dev-work: develop

The default dev-work workflow: **plan → implement → pr-review**, ending at a pull request whose review verdict meets the bar.

**First, read `../../shared/orchestration.md`** (relative to this skill's base directory) in full. It holds the hard rules, setup, the todo's shape, reporting and the after-merge step, shared by every dev-work workflow. This file adds only what is specific to `develop`.

**Caps:** each task's fix loop has 5 rounds (in `implement`); the PR has 3 review rounds (in `pr-review`). At a task cap you rule; at the PR cap with blockers open, the run fails.

## Phases

After setup (per the shared file), with `Workflow: develop` in the todo:

### 1. plan

Set Phase: plan. Run `dev-work:plan` with args:
`{ repo: <worktree>, runDir, scopeFile: <run dir>/scope.md, planFile: <run dir>/plan.md, failureReport: <path, only on a clean restart> }`.

When it returns, **rule**:
- `open` and `new_problems` both empty → accept.
- Otherwise, for each open item or new problem: accept the plan with a ruling, or **fail (design)** if what remains means the design is wrong.
- Keep the plan's Global constraints line and the task count for the next phase.

### 2. implement

Set Phase: implement (task 1). Run `dev-work:implement` with args:
`{ repo: <worktree>, runDir, planFile, globalConstraints: <the plan's Global constraints text>, startTask: 1, taskCount }`.

When it returns:
- `needs_orchestrator`: a coder asked a question. Answer it from the plan, the scope or the thread, or make the call and record it under Rulings. Re-run `dev-work:implement` with `startTask: <that task>` and `answers: <your answer>`. If you genuinely can't answer without the user, fail (design).
- `failed`: fail (operational) with its stage and detail.
- `done`: for each task's `parked` findings (left open at the cap), rule: park it with a ruling (and note it for the PR's Assumptions), or fail (design) if it means the result would be wrong. A disputed finding comes with the coder's evidence; weigh it, and remember a stated reason is not evidence.
- Then **read the commits** (shared file) before the next phase pushes anything.

### 3. pr-review

Set Phase: pr-review (round 1). Run `dev-work:pr-review` with args:
`{ repo: <worktree>, runDir, planFile, scopeFile, baseSha: <base>, branch: dev-work/<slug>, baseBranch: <target branch>, repoSlug: owner/repo, title: <short standalone PR title>, publicContext }`.
When resuming after an operational failure where the PR already exists, also pass `prNumber`.

When it returns:
- `ready`: set Phase: ready, record the PR URL, copy its `follow_ups` under Follow-ups (one line each) and any `refuted` blockers under Rulings. Report success.
- `blocked_at_cap`: fail (design or operational, your judgement) with the open blockers and their links.
- `privacy_blocked`: something about to be posted was flagged. Read the flagged items. If the flag is right, fail (operational) naming the text and why, and suggest the rewording. Never post around the gate.
- `failed`: fail (operational).
