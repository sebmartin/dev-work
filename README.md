# dev-work (prototype, 0.1.1)

Development workflows where an agent orchestrates and dynamic workflows run the loops.

**`/dev-work:develop`** is the general-purpose workflow, and the default. It takes a ticket or a thread todo to a reviewed pull request:
- **plan:** a planner, a plan reviewer and a skeptic, one revision, then a re-check.
- **implement:** tasks in order, each reviewed, with a fix loop capped at 5 rounds.
- **pr-review:** the PR, a review, a verifier that tries to disprove each blocker, then fix and re-review, for up to 3 rounds.

You merge by hand.

More workflows (refactor, architecture review, …) can be added as skills that reuse `shared/orchestration.md` and the phase workflows.

## Requires

- Claude Code with dynamic workflows.
- The Superpowers plugin.
- The ai-workspace plugin.
- `gh`, authenticated.

## Use

```
/dev-work:develop <ticket URL or thread todo>
```

The orchestrator infers the repository and target branch from the ticket and the thread, and asks only if it can't tell. Watch a run with `/workflows`. It ends with "PR ready" or a failure report that suggests fixes. After you merge, say so to review the follow-ups.

Every agent can read the task's thread for background. Privacy rests on one convention, not enforced: everything posted is written to stand alone for a stranger. You skim the PR before merging.

## Status

A prototype, tested in parts. It hasn't yet run end to end on a real repository.

## Layout

```
shared/orchestration.md    rules for every workflow's orchestrator
skills/develop/SKILL.md    /dev-work:develop
workflows/                 plan.js, implement.js, pr-review.js (phase workflows)
```
