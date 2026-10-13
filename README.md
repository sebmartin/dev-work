# dev-work (prototype, 0.1.1)

Development workflows where an agent orchestrates and dynamic workflows run the loops.

**`/dev-work:develop`** is the general-purpose workflow, and the default. It takes a ticket or a thread todo to a reviewed pull request:
- **plan:** a planner, a plan reviewer and a skeptic, one revision, then a re-check.
- **implement:** tasks in order, each reviewed, with a fix loop capped at 5 rounds.
- **pr-review:** a privacy gate, the PR, a review, a verifier that tries to disprove each blocker, then fix and re-review, for up to 3 rounds.

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

The ticket names the repository and, optionally, a target branch. Watch a run with `/workflows`. It ends with "PR ready" or a failure report that suggests fixes. After you merge, say so to review the follow-ups.

Anything posted to GitHub, commit messages included, first passes a privacy gate. The gate flags any reference a stranger couldn't resolve from the repo, ticket and PR. It fails closed.

## Status

A prototype, tested in parts. It hasn't yet run end to end on a real repository.

## Layout

```
shared/orchestration.md    rules for every workflow's orchestrator
skills/develop/SKILL.md    /dev-work:develop
workflows/                 plan.js, implement.js, pr-review.js (phase workflows)
```
