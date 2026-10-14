# dev-work (prototype, 0.1.1)

Takes a thread todo with a linked design through Superpowers to a pull request ready for human review. An agent orchestrator stands where Superpowers expects a human, and a dynamic workflow replaces Superpowers' subagent-driven-development controller.

**`/dev-work:design`** works out a todo's **design** with you through `superpowers:brainstorming`: the decisions, their motivation and the acceptance criteria, saved as an artifact in the todo's thread (never in the repository) and linked from the todo.

**`/dev-work:develop`** takes it from there:
- **plan:** a subagent runs `superpowers:writing-plans` on the design. The plan stays out of the repository.
- **execute:** the `execute` workflow runs the plan the way `superpowers:subagent-driven-development` does, with its prompts, scripts and ledger: a pre-flight scan, each task implemented and reviewed with up to 5 fix rounds, then a final whole-branch review. A ruler agent makes the calls SDD leaves to its controller.
- **finish:** the orchestrator uses `superpowers:finishing-a-development-branch` to push and open the PR, then writes the PR link, rulings and follow-ups back to the thread.

You merge by hand.

## Requires

- Claude Code with dynamic workflows.
- The Superpowers plugin, v7 or later.
- The ai-workspace plugin.
- `gh`, authenticated.

## Use

```
/dev-work:design <thread todo>
/dev-work:develop <thread todo>
```

Watch the execute step with `/workflows`. A run ends with the PR or a report of why it stopped. After you merge, say so to review the follow-ups.

Privacy rests on one convention, not enforced: after the design, nothing reads the thread, and everything published is written to stand alone for a stranger. You skim the PR before merging.

## Status

A prototype. It hasn't yet run end to end on a real repository.

## Layout

```
skills/design/SKILL.md     /dev-work:design (brainstorming, with you)
skills/develop/SKILL.md    /dev-work:develop (the orchestrator)
workflows/execute.js       SDD's controller as a script
```
