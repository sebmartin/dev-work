---
name: develop
description: Takes a thread todo with a linked design to a pull request ready for human review, by launching dev-work's execute workflow, then handles the user's review rounds and closes the work after merge. Use when the user types /dev-work:develop or asks to develop a todo with dev-work, including when they've reviewed or merged its PR.
---

# dev-work: develop

You do the parts that touch the user, the thread and GitHub: set up, launch the `execute` workflow, publish what it returns, and write back. The workflow does everything else: it plans the design with Superpowers' writing-plans, builds it task by task with reviews, reviews the whole branch, and writes the PR description. You don't write code, read diffs or review.

`/dev-work:develop <todo>` is the only command after design. Each time it runs, work out where the todo stands (section 1) and do that part. Every invocation ends the same way (section 6).

## Rules

- **Autonomous once started.** Ask nothing after setup, except where a section below says to. If something needs the user, stop and report what happened, what was tried and what would fix it.
- **The design is the handoff.** The workflow gets the design and nothing else from the thread. If the run would need the thread to decide something, the design is missing it: say so in your report.
- **Pass the design verbatim.** `args` has only the fields in section 3, and `design` is the design artifact's text exactly as saved. Never add notes, context or anything else from the thread.
- **Workers get only what the workflow gives them.** Never give an agent a path into the workspace or a thread, and never tell one about threads.
- **Nothing private leaves the machine.** The workflow writes the commit messages, the PR description and replies from the design and the run's results. Read them before they go out; they must stand alone for a stranger.

## The loop folder

Each todo developed with dev-work has a folder in its thread, `artifacts/dev-work/<YYYYMMDD>-<todo slug>/`, made by `/dev-work:design` and linked from the todo:
- `design.md`: the design, ending with its `## Decision log`. Only changes to the design itself go in the log.
- `log.md`: what develop did, which you keep. Make it on the first run:

```
# <todo title>

Status: <one line: Running, PR open, Stopped: <reason and what would fix it>, Failed at <stage>: <reason>, Merged, Closed>
PR: <link, or none yet>

## History
One line per invocation, oldest first. The kind is one of start, resume, restart, review round <n>, stopped, failed, close.
- <date>, <kind>: <what happened, one line>. A review round also gives the link to the review on GitHub and whether it was pushed.

## Not fixed in this PR
Found during the work and deliberately left out of the PR. At close, the user picks which become todos.
- [ ] <what it is and why it matters, one line>
```

The PR is the record for reviewers and for anyone reading the history later: the decisions, what was left out, every review and reply. The log is the local trail that points to it. Don't write either to the todo.

## 1. Where the todo stands

Check where the session started: it must be a directory that contains the repository (the folder holding the user's repositories, or the repository itself), because the session has to enter a worktree of that repository. If it isn't, stop: tell the user to start a session there, resume the thread, and run `/dev-work:develop <todo>`.

Read the todo, its loop folder's `design.md` and `log.md` (if there is one) from the thread, resumed in this session; the log's Status says how the last run ended. The todo's branch is `dev-work/<todo slug>`, or `dev-work/<todo slug>-<n>` after a restart; the highest `<n>` is the current one. Its worktree is `<repository>/.claude/worktrees/` plus the branch name with `/` replaced by `-`.

| What you find | What to do |
|---|---|
| No branch | **Start**: sections 2 to 4 |
| Branch, no PR, the last run stopped because the design was missing something, and the thread's design differs from the worktree's `.dev-work/design.md` | **Restart**: remove the old worktree (keep its branch), then **Start** on `dev-work/<todo slug>-<n+1>` |
| Branch, no PR, the last run failed or was interrupted, and this session ran it | **Resume**: relaunch it with the same script and `args` (`resumeFromRunId`); completed agents return their saved results. Then section 4 |
| Branch, no PR, the last run stopped for another reason | Report the stop and what would fix it, and ask whether to start over. A relaunch would replay the same stop |
| Branch, no PR, and the run can't be resumed here | **Start over**: remove the old worktree (keep its branch), then **Start** on `dev-work/<todo slug>-<n+1>` |
| Open PR with review feedback since the last round | **Iterate**: section 5 |
| Open PR, no new feedback | Report the PR's state, remove any dev-work worktree left holding the branch (section 2), and stop |
| Merged PR | **Close**: section 6, merged |
| Closed PR, not merged | **Close**: section 6, closed |

## 2. Setup

- **Task:** the todo must link to its loop folder, with a `design.md`. If there is none, stop: the design comes first, with the user (`/dev-work:design`).
- **Repository and target branch:** infer them from the design and the todo; default to the repository's default branch. Ask only if you can't tell. Record the target branch's commit id as the base.
- **Worktree:** `git worktree add <repository>/.claude/worktrees/<name> -b <branch> <base>`, then hide `.claude/worktrees/` through the repository's local exclude file (`git rev-parse --git-path info/exclude`), never `.gitignore`. Enter it with `EnterWorktree` by path. Never `cd` into it. Then use `superpowers:using-git-worktrees`: it sees the session is already isolated and does the project setup and baseline tests. For a review round, recreate the worktree from the existing branch (`git worktree add <path> <branch>`), stage the inputs again, and enter it the same way.
- **Where the branch is already checked out:** before creating or recreating a worktree, find any worktree holding the branch with `git worktree list --porcelain`. If it's one of dev-work's own (under the repository's `.worktrees/` or `.claude/worktrees/`, named `dev-work-…`) and `git status` in it shows nothing uncommitted, remove it with `git worktree remove --force <path>` and carry on. If it has uncommitted changes, stop and report them. If it's anywhere else, such as the user's own checkout, stop, say where, and ask them to switch that checkout away from the branch.
- **`.dev-work/`** in the worktree, hidden through the same exclude file: copy the design there as `design.md` (only to tell later whether it changed), and each file in the todo's Inputs list into `.dev-work/inputs/` under the name the list gives. If a listed file is missing, stop and say which.
- **PR template:** the first that exists: the repository's (`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `PULL_REQUEST_TEMPLATE.md` or `docs/PULL_REQUEST_TEMPLATE.md`), then the user's (`dev-work/pr-template.md` in their Claude Code configuration directory: `$CLAUDE_CONFIG_DIR`, or `~/.claude`), then this plugin's `templates/pr-template.md` (two levels up from this skill's directory).

## 3. Launch

In the same turn as setup, run the `dev-work:execute` workflow with exactly these `args`:
- `design`: the design artifact's text, verbatim.
- `inputs`: for each staged input, `{ name, description }`, the description being the design's line about it.
- `pr_template`: the template's text.
- `base`: the base commit id (all 40 characters).

It returns:
- `done`, with `pr_title`, `pr_body`, `follow_ups`, `rulings`, `parked`, `deferred` and `surfaced`;
- `stopped`, with the reason. If the design is missing something, say so: the user fixes it with `/dev-work:design`, and the next develop restarts;
- `failed`, with the stage. Relaunch it in this session to resume.

## 4. Publish

1. Read every commit message (`git log <base>..HEAD`) and the returned PR title and body for anything private: names of threads, notes or people, or anything that leans on the thread to make sense. Fix the PR text yourself if needed. If a commit message carries something private, stop and report it; don't rewrite history.
2. Push the branch and open the PR into the target branch with `gh`, using the title and body. If pushing or opening the PR is refused, stop and report which account `gh` used. Don't switch accounts or reach for other credentials.
3. **Back to the thread:** in `log.md`, the PR link, the run, and under Not fixed in this PR the workflow's `follow_ups` plus anything parked or deferred worth tracking. Rulings that change the design go in `design.md`'s decision log, with why.

## 5. Iterate on review feedback

The user has reviewed the PR and asked for changes, as review comments on the PR, in a message to you, or both.

1. Recreate and enter the worktree (section 2). Collect the feedback since the last round: the PR's reviews and review comments (with `gh`), plus anything the user told you. Give each item an id.
2. If an item changes what the design says, record it in `design.md`'s decision log first.
3. Launch `dev-work:execute` with `{ design, inputs, pr_template, base, feedback: [{ id, text }], round: <n>, pr: <the PR's current description>, head: <the branch's current commit id> }`. It fixes, reviews the fixes, and returns `replies` (one per item) and `pr_body` (empty unless the description should change).
4. Show the user what changed, item by item, and ask whether to push. This is the one question a round asks, because pushing and replying publish on the user's behalf. If they say yes: read the replies for anything private, push, update the PR description if `pr_body` isn't empty, and post each reply on its comment.
5. Add the round to `log.md`'s History as `<date>, review round <n>: <link to the review on GitHub>. <what changed>; pushed` (or `not pushed`). Design-changing rulings go in `design.md`'s decision log.

## 6. At the end of every invocation

**Close**, when the PR is merged: list what's under Not fixed in this PR in `log.md` and ask which to track as todos (nothing is filed automatically), tick the ones filed, set the log's Status to `Merged`, and retire the todo. When it was closed without merging: ask once whether to retire the todo or park it, do that, and set Status to `Closed`. Either way, remove any worktree still left for the todo (below). Keep the branch.

Every other invocation:
1. **Update `log.md`:** its Status line, and a History line for this invocation.
2. **Leave the worktree** with `ExitWorktree` and `keep`, so the session returns to where it started.
3. **Remove the worktree** once a PR is open (after publishing or a review round), as in section 2: nothing uncommitted, then `git worktree remove --force <path>` from where the session started, which also removes the run's ignored files in `.dev-work/`. Keep the branch. The worktree exists only while develop is working; left in place, it would stop the user checking the branch out anywhere else. After a stop or a failure, keep it for the resume or restart.
4. **Report** to the user: what happened, the PR link, and anything that needs them.
