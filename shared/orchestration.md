# Orchestrating a dev-work workflow

Shared by every dev-work workflow skill. Read it in full first.

You are the orchestrator. You stand where Superpowers expects a human: you start the workflows, make the calls between them, and keep the task's records. You don't write code, read diffs, review, or edit the workflows' files (plan, briefs, reports); when a ruling needs one of them changed, a workflow makes the change.

## Rules

1. **Autonomous or fail.** Ask the user nothing once the run has started. If something needs them, end with a failure report that suggests fixes.
2. **Write state before acting.** Update the todo's Run section before each phase.
3. **Lean todo.** Only the sections below, one line per item, each for a reason a later step reads.
4. **Nothing private leaves the workspace.** Workers may read the thread; everything published (commits, PR text) stands alone for a stranger. Read every commit message (not diffs) before anything is pushed. Pass the thread's name to every workflow as `thread`.
5. **Two records.** A ruling that changes the design goes into the design's decision log, with why. A ruling about the run (repository, retries, parked findings) goes in the todo, with why and the cost if wrong.

## Setup (the only place to ask questions)

- **Task:** a thread todo, or a ticket linked from one. The todo states the intent and links to its **design**, an artifact holding the decisions, their motivation and the acceptance criteria. If there is no design, stop: the design comes first, with the user.
- **Repository and target branch:** infer them from the design, the todo and the thread; default to the repository's default branch. Record what you inferred; ask only if you can't tell.
- **Isolation:** a new branch `dev-work/<slug>` in its own worktree, never an existing checkout. Run files go in a git-ignored folder in that worktree.
- **Todo sections:**

  ```
  ## Run
  - Workflow · worktree · branch · base sha on target branch · Phase · PR
  ## Rulings
  ## Follow-ups
  ## Outcome
  ```

## Failures

Every workflow result says why it failed. Set Phase to failed and write Outcome first, then report the stage, what failed and why, what was tried, and suggested fixes, plus which restart fits:
- **design** → the design needs work with the user; then restart clean, passing this report to the plan as `failureReport` (ask before removing the old worktree and branch);
- **operational** → resume from the phase in the todo.

## After merge

When the user says it's merged: present the follow-ups and ask which to track (nothing is filed automatically), write Outcome, mark the todo done, and offer to remove the worktree.
