# dev-work (prototype, 0.1.1)

Development workflows where an agent orchestrates and dynamic workflows run the loops.

**`/dev-work:develop`** is the general-purpose workflow, and the default. It follows Superpowers' workflow, with the orchestrator standing where Superpowers expects a human. It starts from a thread todo whose **design** (an artifact with the decisions, their motivation and the acceptance criteria) you have already worked out, typically with Superpowers' brainstorming:
- **plan:** `superpowers:writing-plans` turns the design into tasks.
- **implement:** tasks in order, each reviewed, with a fix loop capped at 5 rounds.
- **review:** locally, the whole change reviewed, a verifier that tries to disprove each blocker, then fix and re-review, for up to 3 rounds. It drafts the PR description.
- **publish:** the orchestrator pushes and opens the PR: the point where it's ready for humans.

You merge by hand.

More workflows (refactor, architecture review, …) can be added as skills that reuse `shared/orchestration.md` and the phase workflows.

## Requires

- Claude Code with dynamic workflows.
- The Superpowers plugin, v7 or later.
- The ai-workspace plugin.
- `gh`, authenticated.

## Use

```
/dev-work:develop <thread todo with a linked design>
```

The orchestrator infers the repository and target branch from the design, the todo and the thread, and asks only if it can't tell. Watch a run with `/workflows`. It ends with "PR ready" or a failure report that suggests fixes. After you merge, say so to review the follow-ups.

Every agent can read the task's thread for background. Privacy rests on one convention, not enforced: everything posted is written to stand alone for a stranger. You skim the PR before merging.

## Status

A prototype, tested in parts. It hasn't yet run end to end on a real repository.

## Layout

```
shared/orchestration.md    rules for every workflow's orchestrator
skills/develop/SKILL.md    /dev-work:develop
workflows/                 plan.js, implement.js, review.js (phase workflows)
```
