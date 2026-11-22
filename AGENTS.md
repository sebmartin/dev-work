# dev-work

A Claude Code plugin: `skills/` holds the design, develop and review skills, `agents/worker.md` the agent every workflow step runs as, `workflows/execute.js` the workflow develop launches, and `workflows/review-wf.js` the workflow `/dev-work:review` launches. The review workflow is kept separate from `execute` so the author's and the reviewer's workflows change separately, and is named `-wf` because Claude Code lists every script in `workflows/` as a command.

## Tests

`node --test` runs `tests/`, which loads `workflows/execute.js` with stand-in agents and checks its control flow, its prompts and its result. `tests/review-wf.test.mjs` does the same for `review-wf.js`. It needs Node 22 or later and nothing else. Run it after any change to the workflow, and add a test for any new path, especially one that is meant to fail closed.

## README

Every change that alters what a user sees or does (commands, what develop does, what it writes, requirements, setup) updates README.md in the same PR. Before opening a PR, read the README against the change and fix anything it makes stale.

## Version

Every PR that changes a skill, an agent, the workflow or a template bumps `version` in `.claude-plugin/plugin.json`, because installed copies only update when the version changes. While the version is 0.x, bump the minor version when what develop or design does changes, and the patch version for fixes that leave it the same. A PR that changes only tests, the README or this file doesn't bump it.
