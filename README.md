# dev-work (prototype, 0.1.1)

A plugin of development workflows. Each workflow takes a ticket or a todo to a reviewed pull request, with an agent orchestrating and code running the loops.

**Workflows:**
- **`/dev-work:develop`** is the general-purpose one, and the default: plan → implement → pr-review. It's the only one so far.
- **Later additions** (a refactor workflow, an architecture review, …) would be new skills that reuse the same shared orchestration rules and, where they fit, the same phase workflows.

**How `develop` runs:**
- **The orchestrator** is your Claude Code session, ideally on Fable, running the workflow's skill. It briefs, rules and reports, and never writes code. The rules every workflow shares are in `shared/orchestration.md`.
- **Phase workflows** do the work. These are dynamic workflows whose loops, counters and caps are JavaScript, not prompts.
  - **`plan`**: a planner (Superpowers `writing-plans`), then a plan reviewer and a skeptic, one revision, and a re-check.
  - **`implement`**: tasks run in order, using Superpowers' implementer, task-reviewer and re-review templates. Each task has a fix loop capped at 5 rounds, with Opus taking rounds 4–5.
  - **`pr-review`**: a privacy gate, then push and open the PR. A first review on Opus, a verifier that tries to disprove each blocker, and posting to GitHub. Then fix, re-review and post again, for up to 3 rounds.
- **State.** The task's state lives in a short todo document in an ai-workspace thread. Working files live in a git-ignored `.dev-work/` folder in the run's worktree.

This is a prototype. It has been tested only in pieces, never end to end. Expect rough edges, and read "Watch for" before your first run.

## Before you start

1. **Claude Code with dynamic workflows.** Recent enough that `/workflows` exists. Workflows must not be disabled in `/config`.
2. **Superpowers, installed from a registered marketplace:** `/plugin install superpowers@claude-plugins-official`. In remote-control sessions, a copy from the Anthropic plugin directory didn't load. dev-work uses Superpowers' skills, prompt templates and scripts (`task-brief`, `review-package`) as they are.
3. **The ai-workspace plugin,** for threads and todos, and for its `skeptic` agent, which reviews the plan.
4. **`gh`, authenticated** with push and PR rights on the target repository. Check with `gh auth status`.
5. **Install dev-work.** This folder is a local marketplace:
   ```
   /plugin marketplace add <path to this repository, the folder containing .claude-plugin/marketplace.json>
   /plugin install dev-work@dev-work-local
   ```
   Then start a new session. A plugin installed mid-session doesn't load.
6. **Permissions, so a long run doesn't stall on prompts.** Workflow agents use your permission rules. In settings, allow:
   - `Workflow`
   - `Bash(git:*)`, `Bash(gh:*)`, `Bash(bash:*)`
   - your test runner, for example `Bash(uv:*)` or `Bash(npm:*)`
   - Read, Edit and Write in the worktree's parent directory.

   Auto mode works too. It asks once to approve the first workflow launch.
7. **Model.** Run the session on Fable if you have it, or else the strongest model available. Agents name their own models: Opus for the planner, the PR review, the verifier and the privacy gate; Sonnet for coding and task review; Haiku for mechanical steps.

## Using it

From the target repository's directory, in a session with your thread resumed:

```
/dev-work:develop https://github.com/owner/repo/issues/123
/dev-work:develop the todo "Add CSV export"
```

1. **Setup.** The orchestrator finds or creates the todo, and creates a worktree and branch `dev-work/<slug>` from the default branch. Your checkout is never touched. It also writes a scope statement for strangers.
2. **Plan.** Then it rules on what's left open.
3. **Implement.** Then it rules on any findings parked at a task's cap, and reads the commit messages, never the diffs.
4. **PR.** Then it reports.

You can watch any phase live with `/workflows`. Your session stays free while one runs.

**At the end, one of two things:**
- **"PR ready."** Skim the PR and merge it by hand, then tell the session it's merged. It shows the follow-ups and asks which to track. Nothing gets filed automatically.
- **A failure report.** It says what failed, what was tried, suggested fixes, and whether to **restart clean** (the design was wrong: adjust the scope and run again) or **resume** (something operational broke: fix it and say "resume").

## What you'll see on GitHub

- **One PR,** with a description that stands on its own, filled into your repo's PR template if there is one.
- **A review each round,** posted as a COMMENT review, never an approval. Each finding is labelled `R1-2 · blocker`, `follow-up` or `nitpick`, inline where the line is in the diff.
- **A reply on every thread:** `fixed in <sha>`, `disputed` (with evidence), `dropped` or `follow-up`. Threads are resolved once the re-review verifies the fix.
- **Everything posted, including commit messages, passes the privacy gate first.** The gate flags anything a stranger with only the repo, ticket and PR couldn't make sense of: people, meetings, internal decisions, projects, private facts. It fails closed: when it flags something, nothing is posted and the run stops.

## Watch for

- **First run:** pick a small, low-stakes ticket, on a private repo if you can.
- **Untested end to end.** The pieces were tested separately: plugin skills loading inside workflows, the Superpowers scripts, the privacy gate on planted leaks, and the implement loop on a toy repo with planted defects. The plan and PR workflows and the orchestrator haven't run against a real repo. The likely failure points are GitHub posting (inline comment positions, thread resolution) and the first permission prompts.
- **The PR is real.** The `pr-review` workflow pushes the branch and opens a pull request. Use a private repo the first time if you're unsure.
- **Cost.** A run is maybe 15–40 agents, depending on task count and rounds, with Opus at high effort in several places. Watch the token counts in `/workflows`. Stop a run there with `x` and nothing completed is lost.
- **The plan checker** is Superpowers 6.4.1's plan-document reviewer, with the "questions an implementer would ask" sort added on. Superpowers v7's builder check will replace it once the marketplace pin moves.
- **Reviewer model.** Codex isn't wired in yet. Opus does the PR review.
- **No bot handling.** Comments from CodeRabbit, Copilot and the like on the PR are ignored by the loop. Read them yourself when you skim.
- **Coders run in order,** one worktree per run, no parallel coders.
- **Resuming.** A workflow resumes only in the session that started it. In a new session, the orchestrator re-runs the phase recorded in the todo.
- **Superpowers version drift.** dev-work reads Superpowers' template files by path, from the newest copy installed through the official marketplace (`claude-plugins-official`). If a future version renames a template or changes its placeholders, the workflows break. They say which file.
- **Privacy is checked twice** before anything is pushed or posted: the orchestrator reads the commit messages, and the gate checks everything. Neither one knows the thread's private content. Leaks are caught by spotting references a stranger couldn't resolve, so a private fact phrased as general advice could slip through.

## Layout

```
dev-work/
├── .claude-plugin/plugin.json
├── shared/orchestration.md       rules every workflow's orchestrator follows
├── skills/develop/SKILL.md       /dev-work:develop: the general-purpose workflow
└── workflows/                    phase workflows, reusable across workflows
    ├── plan.js                   dev-work:plan
    ├── implement.js              dev-work:implement
    └── pr-review.js              dev-work:pr-review
```

## Adding a workflow

1. Add a skill under `skills/<name>/SKILL.md` that starts by reading `shared/orchestration.md`. Then list its phases, the args for each phase workflow, and the rulings it makes.
2. Reuse the phase workflows that fit, for example `implement` and `pr-review` for a refactor. Add new ones under `workflows/` only for genuinely new phases.
