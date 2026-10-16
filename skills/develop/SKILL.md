---
name: develop
description: Takes a thread todo with a linked design through Superpowers to a pull request ready for human review, with you standing where Superpowers expects a human. Use when the user types /dev-work:develop or asks to develop a todo with dev-work, and when they say a dev-work PR has been merged.
---

# dev-work: develop

Superpowers is the process. You stand where it expects a human: you start each step, answer for the user, and write the outcome back to the thread. You don't write code, read diffs or review.

## Rules

- **Autonomous once started.** Ask nothing after setup. If something needs the user, stop and report what happened, what was tried and what would fix it.
- **The design is the handoff.** Work from it, not from the rest of the thread. If you'd need the thread to decide something, the design is missing it: say so in your report.
- **Nothing private leaves the machine.** Commits and PR text stand alone for a stranger: no names of threads, designs, plans or the people in them, and nothing from their notes. Read every commit message and the PR text before you push.

## 1. Setup (the only place to ask)

- **Task:** a thread todo that links to its **design**, an artifact holding the decisions, their motivation and the acceptance criteria. If there is no design, stop: the design comes first, with the user (`/dev-work:design`).
- **Repository and target branch:** infer them from the design and the todo; default to the repository's default branch. Ask only if you can't tell.
- **Worktree:** with `superpowers:using-git-worktrees`, on a new branch `dev-work/<todo slug>`, never an existing checkout. If that branch already exists, this is a resumed run: reuse its worktree and pick up at the first step that hasn't finished. Record the base sha on the target branch.
- **Run folder:** the plan goes in a folder that git ignores through the repository's local exclude file (`git rev-parse --git-path info/exclude`), never `.gitignore`.

## 2. Plan

Dispatch one subagent (Opus, medium effort) to use `superpowers:writing-plans` on the design:
- save the plan in the run folder, and don't commit it;
- the design is decided: plan it, don't redesign it;
- plan only what the design asks, and list anything else under "## Follow-ups";
- it may read code and run the repository's existing commands, but not write or run new code;
- nobody will answer questions: make the call and record it under "## Assumptions".

Then read the plan the way the user would: does it match the design, are its assumptions acceptable, and does it carry anything private that could reach a commit? If it misreads the design, stop. You may make small edits to the plan where it misses something the design needs; record each as a ruling, with what it costs if wrong.

## 3. Execute

Run the `dev-work:execute` workflow with `{ repo: <worktree>, planFile, designFile, baseSha }`. It runs `superpowers:subagent-driven-development` with the script as the controller and a ruler agent making the controller's calls. When you start it, tell the user that anything they type in this session while it runs also reaches the workflow's agents and can derail it, so they should wait for your report.
- `done`: carries rulings, parked findings, deferred findings and anything surfaced for a human.
- `stopped`: one of SDD's stop cases, with the reason. Report it.
- `failed`: an operational failure, with the stage. Run it again; it resumes from SDD's ledger.

## 4. Finish

Use `superpowers:finishing-a-development-branch` and choose to push and open a pull request into the target branch. Before pushing, read the commit messages. Write the PR text to stand alone, and include anything execute surfaced as needing a human.

## 5. Back to the thread

- **Todo:** the PR link; the rulings, one line each with what they cost if wrong; the follow-ups (the plan's, plus parked and deferred findings).
- **Design:** rulings that change it go in its decision log, with why.
- **Report:** the PR link, the rulings, the follow-ups and anything surfaced. The user skims and merges by hand.

## After merge

When the user says it's merged: present the follow-ups and ask which to track (nothing is filed automatically), retire the todo, and offer to remove the worktree and branch.
