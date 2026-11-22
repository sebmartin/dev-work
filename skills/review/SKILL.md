---
name: review
description: Reviews a pull request with dev-work's review workflow: a full first review, then on each later run checks the author's fixes and replies in each finding's thread and reviews what changed, deciding in code when the review is done. Use when the user types /dev-work:review or asks dev-work to review or re-review a PR.
---

# dev-work: review

You are the orchestrator. You do the parts that touch GitHub and the machine: read the pull request with `gh`, check it out read-only in its own worktree, check for Codex, launch the `review-wf` workflow, read what it wrote for anything private, and post the round. The workflow decides what to review, what is settled and when the review is done. You don't review, read diffs or judge findings.

`/dev-work:review <PR>` is run once per round. `<PR>` is a number or a URL. The repository is the one in the session's directory, or the URL's.

## Rules

- **Ask nothing and wait for no one once started.** The command must run unchanged from a later loop. If something stops the run, report what happened, what was tried and what would fix it.
- **Use `gh` as it is,** with whatever account is active. Never use another account's token, even to read.
- **Never write to the thread.** Nothing from a todo's thread goes on the PR or to an agent, other than the design in section 2.
- **Agents get only what the workflow gives them.** `args` has only the fields in section 6. Never give an agent a path into a workspace or a thread.
- **Nothing private on the PR.** Section 7 reads everything before it is posted.

## The user's logins

Read `dev-work/review-logins` in the Claude Code configuration directory (`$CLAUDE_CONFIG_DIR`, or `~/.claude`): one GitHub login per line, blank lines and lines starting with `#` ignored. These are the logins the workflow treats as the user's: their PRs get a submitted review and their replies count as the user's.

When the file is missing or empty, use the active account: `gh api user --jq '.login + " " + .type'`. If that login ends with `-bot` or `[bot]`, or its type is `Bot`, stop before reading the PR further and say to list the user's logins in that file.

## 1. Read the PR

- `gh pr view <n> --json number,url,title,body,author,headRefName,headRefOid,baseRefOid,isCrossRepository`.
- The changed files with a paginated call, because `gh pr view --json files` stops at 100: `gh api repos/<owner>/<repo>/pulls/<n>/files --paginate --jq '.[].filename'`. These paths are `files` in `args.pr`.
- Reviews and review threads with `gh api graphql --paginate`. Reviews: `id`, `author{login}`, `body`, `commit{oid}`, `state`, `submittedAt`. Review threads: `id`, `isResolved`, `path`, `line`, `comments{ id, author{login}, body, createdAt, url }`.
- Map them to the `args` field names: reviews `{ id, author, body, commit, state, submitted_at }`, where `commit` is the head SHA the review was submitted on (null when there isn't one), and threads `{ id, url, path, line, resolved, comments: [{ id, author, body, created_at, url }] }`, with `url` the first comment's url. An author that is null (a deleted account) stays null.

## 2. Find the design

If the PR's branch is `dev-work/<todo slug>` or `dev-work/<todo slug>-<n>` and the session has that todo's thread resumed, read `design.md` from that todo's loop folder and pass it verbatim. Otherwise pass `design: ''` and say in the report that the PR was reviewed without a design.

## 3. Pending draft

If any review has state `PENDING`, report it with the PR link and stop: there is one pending review per person per PR.

## 4. Worktree

The worktree is `<repository>/.claude/worktrees/review-<PR number>`.

1. Remove one left from an earlier run first: `git worktree remove --force <path>`.
2. `git fetch origin refs/pull/<n>/head` and `git fetch origin <baseRefOid>`.
3. `git worktree add --detach <path> <headRefOid>`.
4. Hide `.claude/worktrees/` through the file `git rev-parse --git-path info/exclude` names (add the line if it isn't there).
5. Enter it with `EnterWorktree` by path.

`base` is `git merge-base <headRefOid> <baseRefOid>`. For a later round (a review whose body has `<!-- dev-work:review round=`), `git fetch origin <commit of the latest such review>`. `since_fetched` is whether that commit is now present (`git cat-file -e <sha>^{commit}`), and true in round 1. Nothing is written or committed in the worktree.

## 5. Codex

Run `command -v codex` and `codex login status`. `codex` is `{ available, reason }`. When it isn't available the reason is "not installed" or "not signed in" (the status output's first line).

## 6. Launch

Note the session's start time, then launch `dev-work:review-wf` with exactly these `args` fields:

- `pr`: `{ number, url, repo: 'owner/name', title, body, author, head: headRefOid, base: <the merge base>, files: [every changed path, from the paginated call in step 1] }`
- `logins`
- `design`
- `reviews`
- `threads`
- `since_fetched`
- `codex`

## 7. Read every comment

Read every comment in `review` (bodies, replies, summary) for anything private: names of threads, notes or people, or anything that leans on the design to make sense. Fix wording only, never markers, prefixes, the status line or the footer.

## 8. Post the round

When `review` is not null, post it through GraphQL:

1. `addPullRequestReview(pullRequestId, commitOID: review.commit)` makes a pending review.
2. Each comment goes in with `addPullRequestReviewThread` (`path`, `line`, `side: RIGHT`; `subjectType: FILE` when `line` is 0). A comment GitHub rejects for its line is retried file-level on the same path.
3. Each reply goes in with `addPullRequestReviewThreadReply` on its thread.
4. On `event: COMMENT`: `submitPullRequestReview(event: COMMENT, body)`, then `resolveReviewThread` for each of `resolve` and `unresolveReviewThread` for each of `unresolve`.
5. On `event: PENDING`: `updatePullRequestReview(body)` and leave it pending for the user to read and submit.

If any call fails before the submit, delete the pending review (`deletePullRequestReview`) so no half-round is left, and report the failure.

## 9. Report

In a few lines:

- the round, and what it found or settled;
- whether Codex ran and, if not, why (`codex.reason`);
- whether the review is done;
- each `needs_human` entry with its thread link;
- the review's link, and whether it was submitted or saved as a draft for the user to read and submit;
- `skipped`, when nothing was posted;
- the cost: the duration the session measured, and `output_tokens`.

Then one line of JSON: `{ done, round, full_pass, open, needs_human }`. A `failed` result reports its `stage` and `error`.

## 10. Leave

Whatever the outcome, leave the worktree with `ExitWorktree` and `keep`, then `git worktree remove --force <path>`.
