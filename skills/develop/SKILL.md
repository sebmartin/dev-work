---
name: develop
description: Takes a thread todo with a linked design through Superpowers to a pull request ready for human review, with you standing where Superpowers expects a human, then handles the user's review rounds and closes the work after merge. Use when the user types /dev-work:develop or asks to develop a todo with dev-work, including when they've reviewed or merged its PR.
---

# dev-work: develop

Superpowers is the process. You stand where it expects a human: you start each step, answer for the user, and write the outcome back to the thread. You don't write code, read diffs or review.

`/dev-work:develop <todo>` is the only command after design. Each time it runs, work out where the todo stands from git and GitHub (section 1) and do that part. Every invocation ends the same way (section 8).

## Rules

- **Autonomous once started.** Ask nothing after setup, except where a section below says to. If something needs the user, stop and report what happened, what was tried and what would fix it.
- **The design is the handoff.** Work from it, not from the rest of the thread. If you'd need the thread to decide something, the design is missing it: say so in your report.
- **Workers get only what you give them.** Every agent you start (the planner, and every agent in `execute`) sees only the worktree, the staged copies in `.dev-work/` and its prompt. Never give one a path into the workspace or a thread, and never tell one about threads.
- **A develop run writes only inside its worktree,** apart from the commits, the branch and the PR. Only you write to the thread, as the last step of an invocation.
- **Nothing private leaves the machine.** Commits, PR text and PR replies stand alone for a stranger: no names of threads, designs, plans or the people in them, and nothing from their notes. Read every commit message, the PR text and every reply before it goes out.

## 1. Where the todo stands

First, check where the session started: if it's the ai-workspace workspace or inside it, stop before anything else, because agents started from here would be given the workspace's instructions. Tell the user to start a new session in the directory that holds their repositories and run `/dev-work:develop` there.

Then read the todo and its design. The todo's branch is `dev-work/<todo slug>`, or `dev-work/<todo slug>-<n>` after a restart; the highest `<n>` is the current one. Its worktree is `<repository>/.worktrees/` plus the branch name with `/` replaced by `-`.

| What you find | What to do |
|---|---|
| No branch | **Start**: sections 2 to 7 |
| Branch, no PR, and the todo's status says the last run stopped because the design was missing something, and the thread's design now differs from `.dev-work/design.md` | **Restart**: remove the old worktree (keep its branch), then **Start** on `dev-work/<todo slug>-<n+1>` |
| Branch, no PR | **Resume**: enter the worktree; plan if `.dev-work/plan.md` is missing; run `execute` (it resumes from its ledger); then finish |
| Open PR with review feedback since the last round | **Iterate**: section 6 |
| Open PR, no new feedback | Report the PR's state and stop |
| Merged PR | **Close**: section 7, merged |
| Closed PR, not merged | **Close**: section 7, closed |

## 2. Setup (the only place to ask)

- **Task:** the todo must link to its **design**, an artifact holding the decisions, their motivation and the acceptance criteria. If there is no design, stop: the design comes first, with the user (`/dev-work:design`).
- **Repository and target branch:** infer them from the design and the todo; default to the repository's default branch. Ask only if you can't tell. Record the base sha on the target branch.
- **Worktree:** create it with `git worktree add` in the repository's `.worktrees/` folder, on the new branch from the target branch, never an existing checkout; hide `.worktrees/` through the repository's local exclude file (`git rev-parse --git-path info/exclude`), never `.gitignore`. Move the session into it with `EnterWorktree` (by path), then use `superpowers:using-git-worktrees`: it sees the session is already isolated and does the project setup and baseline tests. To resume or iterate, enter the existing worktree the same way.
- **`.dev-work/`** at the root of the worktree, hidden through the same local exclude file: the staged design and inputs, the plan, evidence files tasks produce, reports and the PR text. Workers keep scratch files in `.dev-work/scratch/`.
- **Stage the inputs:** copy the design to `.dev-work/design.md`, and each file in the todo's Inputs list to `.dev-work/` under the name the list gives (for example `.dev-work/inputs/cases.json`). If a listed file is missing, stop and say which. From here on, every agent uses only these copies.

## 3. Plan

Dispatch one subagent of type `dev-work:worker` (Opus, medium effort) to use `superpowers:writing-plans` on `.dev-work/design.md`:
- save the plan as `.dev-work/plan.md`, and don't commit it; its Spec line is `.dev-work/design.md`;
- the design is decided: plan it, don't redesign it;
- plan only what the design asks, and list anything else under "## Follow-ups";
- it may read code and run the repository's existing commands, but not write or run new code;
- nobody will answer questions: make the call and record it under "## Assumptions".

Then read the plan the way the user would: does it match the design, are its assumptions acceptable, and does it carry anything private that could reach a commit? If it misreads the design, stop. You may make small edits to the plan where it misses something the design needs; record each as a ruling, with what it costs if wrong.

## 4. Execute

Run the `dev-work:execute` workflow with `{ repo: <worktree>, planFile: <worktree>/.dev-work/plan.md, designFile: <worktree>/.dev-work/design.md, baseSha }`. It runs `superpowers:subagent-driven-development` with the script as the controller and a ruler agent making the controller's calls; every agent it starts is a `dev-work:worker`. When you start it, tell the user that anything they type in this session while it runs also reaches the workflow's agents and can derail it, so they should wait for your report.
- `done`: carries rulings, parked findings, deferred findings and anything surfaced for a human.
- `stopped`: one of SDD's stop cases, with the reason. If the reason is that the design is missing something, say so: the user fixes the design with `/dev-work:design`, and the next develop restarts.
- `failed`: an operational failure, with the stage. Run it again; it resumes from its ledger.

## 5. Finish

Use `superpowers:finishing-a-development-branch` and choose to push and open a pull request into the target branch. Before pushing, read the commit messages.

**The PR description.** Use the first template that exists: the repository's own (`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `PULL_REQUEST_TEMPLATE.md` or `docs/PULL_REQUEST_TEMPLATE.md`), then the user's (`dev-work/pr-template.md` in their Claude Code configuration directory: `$CLAUDE_CONFIG_DIR`, or `~/.claude`), then this plugin's `templates/pr-template.md` (two levels up from this skill's directory). Fill it in. Whatever the template, the PR must give a reviewer the run's context, so add any of these the template has no place for:
- **Decisions and trade-offs:** every ruling from the run (what was decided, why, what it costs if wrong), the plan's assumptions, and the design decisions that shape the code, each stated in its own terms.
- **Not done:** the design's non-goals, the plan's follow-ups, parked findings with the ruling that parked them, and deferred findings worth knowing.
- **Testing:** the evidence: commands, results and any measurements the tasks produced.
- **Review:** what the automated review did (fix rounds, what was parked) and anything surfaced for a human.

Write the PR text to `.dev-work/pr-body.md` and read it for privacy before it goes out.

**Back to the thread.** In the todo's `## Development` section: the PR link and the follow-ups to offer at close. Rulings that change the design go in the thread's design (not the staged copy), in its decision log, with why. The rulings themselves live in the PR.

## 6. Iterate on review feedback

The user has reviewed the PR and asked for changes, as review comments on the PR, in a message to you, or both.

1. Enter the worktree. Collect the feedback since the last round: the PR's reviews and review comments (with `gh`), plus anything the user told you. Give each item an id.
2. If an item changes what the design says, record it in the thread design's decision log first, then copy the design to `.dev-work/design.md` again.
3. Run `dev-work:execute` with `{ repo, planFile, designFile, baseSha, feedback: [{ id, text }], round: <n> }`. It runs fix rounds on the feedback, each reviewed, with the same cap and breaker as the task loop.
4. Show the user what changed, item by item, and ask whether to push. This is the one question a round asks, because pushing and replying publish on the user's behalf. If they say yes: push, then reply on the PR to each comment with what was done, or why it wasn't, standing alone for a stranger.
5. Add a line to the todo's `## Development` section: `Round <n>: <what changed>`, plus any design-changing rulings in the design's decision log.

## 7. Close

**Merged:** present the follow-ups and ask which to track as todos (nothing is filed automatically), then retire the todo with a final status line, `Merged: <PR link>`.

**Closed without merging:** ask once whether to retire the todo or park it, and do that, with a final status line, `Closed: <PR link>`.

Either way, then remove the worktree, from outside it. That one step removes everything the run left behind: `.dev-work/` and SDD's files are inside it. Keep the branch.

## 8. At the end of every invocation

1. **Status line** in the todo's `## Development` section, replacing the previous one: `PR open: <link>`, `Stopped: <reason, and what would fix it>`, `Failed at <stage>: <reason>`, `Round <n>: pushed` or `Round <n>: not pushed`, `Merged` or `Closed`.
2. **Leave the worktree** with `ExitWorktree` and `keep`, so the session returns to where it started and the worktree stays for the PR, a resume or the next round. Skip this after Close, which removed it.
3. **Report** to the user: what happened, the PR link, and anything that needs them.
