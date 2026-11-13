# dev-work

A Claude Code plugin: `skills/` holds the design and develop skills, `agents/worker.md` the agent every workflow step runs as, and `workflows/execute.js` the workflow develop launches.

## Tests

`node --test` runs `tests/`, which loads `workflows/execute.js` with stand-in agents and checks its control flow, its prompts and its result. It needs Node 22 or later and nothing else. Run it after any change to the workflow, and add a test for any new path, especially one that is meant to fail closed.
