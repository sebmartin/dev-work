# dev-work

dev-work is a Claude Code plugin for doing development work with agents. You describe a change and work out its design with Claude. dev-work then plans and implements the change, reviews the result, and opens a pull request for you to review and merge.

It builds on two other plugins:

- [Superpowers](https://github.com/obra/superpowers) provides the development process: brainstorming a design, writing a plan, implementing the plan task by task with a separate agent reviewing each task, and finishing the branch. dev-work runs these skills and makes the decisions that Superpowers normally asks a person to make.
- [ai-workspace](https://github.com/sebmartin/ai-workspace-plugin) organizes long-running work into threads. A thread is a folder of markdown files for one topic: notes from past sessions, decisions, todos and other documents. Threads live in a directory called the workspace. In dev-work, each piece of work starts as a todo in a thread, and its design is saved in the same thread.

## How it works

There are two commands.

`/dev-work:design <todo>` is the part you do with Claude. It runs Superpowers' brainstorming skill on the todo. Claude asks you questions, writes a design (what to build and why, the decisions made, and the acceptance criteria), and has a separate agent check that the design is complete enough to plan from. The design is saved in the thread and linked from the todo. Nothing is written to the code repository.

`/dev-work:develop <todo>` does the rest and asks you nothing after setup:

1. It creates a git worktree on a new branch, and copies the design and any input files the design lists into a `.dev-work/` folder in that worktree. Git ignores that folder.
2. An agent writes an implementation plan from the design, using Superpowers' writing-plans skill.
3. A dynamic workflow called `execute` carries out the plan the way Superpowers' subagent-driven-development skill describes. For each task, one agent implements it and another reviews it, with up to five rounds of fixes. Questions that Superpowers would normally leave to a person are decided by a separate agent, and each decision is recorded with its reason. After the last task, the whole branch is reviewed once more.
4. It runs the tests, pushes the branch and opens a pull request.
5. It writes the pull request link, the decisions it made and any follow-up work back to the todo.

You review the pull request and merge it yourself.

## Keeping thread content private

Threads can hold private notes, so the agents that write code are not given them. They see only the worktree and the copies in `.dev-work/`. They run as a dedicated agent type, `dev-work:worker`, which can't use the ai-workspace tools. Develop also refuses to start in a session opened in the workspace directory, because agents started from there would receive the workspace's instructions. Commit messages and pull request text are written so that someone who has never seen the thread can follow them.

## Requirements

- Claude Code, with dynamic workflows enabled.
- The Superpowers plugin, version 7 or later.
- The ai-workspace plugin.
- The GitHub CLI (`gh`), signed in.

## Usage

Run the design step in a session opened in your workspace:

```
/dev-work:design <todo>
```

Then start a new session in the directory that holds your code repositories, not the workspace, and run:

```
/dev-work:develop <todo>
```

You can follow the implementation step with `/workflows`. The run ends with a pull request, or with a report explaining why it stopped. Don't type into the session while the workflow is running, because messages typed then also reach the workflow's agents. After you merge, tell develop, so it can list the follow-ups and remove the worktree.

## Files

```
skills/design/SKILL.md     /dev-work:design
skills/develop/SKILL.md    /dev-work:develop
agents/worker.md           the agent type used for planning, implementing and reviewing
workflows/execute.js       the execute workflow
```
