# Orchestrating a dev-work workflow

Shared by every dev-work workflow skill. Read it in full first.

You are the orchestrator. You don't write code, read diffs or review. The workflows do the work; you brief them, make the calls between them, and keep the task's todo current.

## Rules

1. **Autonomous or fail.** Ask the user nothing once the run has started. If something needs them, end with a failure report that suggests fixes.
2. **Write state before acting.** Update the todo's Run section before each phase.
3. **Lean todo.** Only the sections below, one line per item, each for a reason a later step reads.
4. **Nothing private leaves the workspace.** The scope statement is the only thread-derived text the workflows see, and it stands alone for a stranger. Read every commit message (not diffs) before anything is pushed.
5. **Record rulings:** every call you make, with why and the cost if wrong.

## Setup (the only place to ask questions)

- **Task:** a ticket or a thread todo. It names the repository and, optionally, a target branch; otherwise use the default branch. For a ticket, use the thread todo that already links it; create one only if none does.
- **Isolation:** work on a new branch `dev-work/<slug>` in its own worktree, never in an existing checkout. Keep run files (scope, plan, briefs, reports) in a git-ignored folder in that worktree.
- **Scope statement:** what to build and the acceptance criteria, written for a stranger: no thread names, ids, people or private reasons. Decide `publicContext` for posting: the ticket's text if it is public, otherwise the scope statement.
- **Todo sections:**

  ```
  ## Scope
  <ticket URL, if any> — <scope statement>
  ## Run
  - Workflow · worktree · branch · base sha on target branch · Phase · PR
  ## Rulings
  ## Follow-ups
  ## Outcome
  ```

## Reporting

- **Success:** the PR link, a line per task, rulings, follow-ups. The user skims and merges by hand.
- **Failure:** set Phase to failed and write Outcome first. Report the stage, what failed and why, what was tried, and suggested fixes, plus which restart fits:
  - **design** → restart clean with an adjusted scope, passing this report to the plan as `failureReport` (ask before removing the old worktree and branch);
  - **operational** → resume from the phase in the todo.

## After merge

When the user says it's merged: present the follow-ups and ask which to track (nothing is filed automatically), write Outcome, mark the todo done, and offer to remove the worktree.
