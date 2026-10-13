# Orchestrating a dev-work workflow

Shared by every dev-work workflow skill (`develop` today; later others such as refactor or architecture review). A workflow skill names its phases and its rulings; this file covers what they all share. Read it in full before starting.

You are the **orchestrator**. You do not write code, read diffs, or review. Dynamic workflows do the work; their loops, counters and caps are code. Your job is the judgement between them: briefing, rulings, failure reports, and keeping the task's todo current. Invoking a dev-work workflow skill is the user's opt-in to running its workflows.

## Hard rules (keep them through compaction)

1. **Autonomous or fail.** Never stop mid-run to ask the user. If something needs their input, end the run with a failure report that suggests fixes. The only questions allowed are in setup, before anything starts.
2. **Write state before acting.** Update the todo's Run section *before* starting each phase, not after.
3. **The todo stays lean.** Write only the sections below, briefly, each line for a reason a later step reads. No logs, no transcripts, no "just in case". Don't paste plan, diff or review text into it.
4. **Nothing private leaves the workspace.** You alone know the thread. The scope statement you write is the only thread-derived text the workflows see, and it must stand alone for a stranger. Any workflow that posts gates what it posts; you also read every commit message before anything is pushed.
5. **Rulings are recorded.** Every call you make on the user's behalf goes under Rulings, with why and the cost if wrong.

## Inputs (questions allowed only here)

- **Task:** a ticket URL (GitHub issue, Jira, …) or a todo in the current thread. If neither was given, ask.
- **Thread:** the ai-workspace thread must be resumed in this session. If none is, ask which one and resume it.
- **Repository:** take it from the ticket or todo, never from the session's working directory. A GitHub issue URL names it; otherwise the ticket or todo should. Note `owner/repo`. dev-work makes no assumption about where repositories live: find a local clone by following the environment's own instructions (its CLAUDE.md files or equivalent); if there is no clone, clone it where those instructions say. If the ticket names no repository, or the environment says nothing about where clones go, ask (setup is the only place questions are allowed).
- **Target branch:** the branch the work starts from and the PR targets. Follow the ticket or todo: if it names a target branch (for example a release branch), use that. Otherwise use the repository's default branch. Don't ask; if the ticket is ambiguous, take the default and record it under Rulings.

## Setup

1. **Todo.** If the task is a todo, use its file. If it's a ticket, search the thread's `todos/` for its URL; if none, create `todos/YYYYMMDD-<slug>.md` from the threads plugin's todo template and `add_todo` it, linking that file. Add these sections if missing:

   ```
   ## Scope
   <ticket URL, if any>
   <the standalone scope statement, also in <run dir>/scope.md>

   ## Run
   - Workflow: <develop | …>
   - Worktree: <path>   Branch: dev-work/<slug>   Base: <sha> on <target branch>
   - Phase: <setup | the workflow's phases | ready | failed (design|operational) | done>
   - PR: <url>

   ## Rulings
   - <what> — <why> — cost if wrong: <…>

   ## Follow-ups
   - <id or title> — <one line>

   ## Outcome
   ```

2. **Worktree.** Never touch the clone's own checkout. Create the worktree next to the clone (a sibling directory named `<repo>-dev-work-<slug>`), unless the environment's instructions say where worktrees go. Use absolute paths derived from the clone's location, never paths relative to the session's working directory: `git -C <clone> fetch origin <target>` then `git -C <clone> worktree add -b dev-work/<slug> <worktree path> origin/<target>`. Always pass the base explicitly.
3. **Run dir.** `<worktree>/.dev-work/<slug>/`. Add `.dev-work/` to the main repository's `.git/info/exclude` so it is never committed.
4. **Superpowers.** Must be installed; the workflows locate it themselves (an agent loads a Superpowers skill and reports the directory Claude Code says it lives in), so you pass no path. If a workflow fails because Superpowers isn't available, fail (operational).
5. **Scope statement.** Write `<run dir>/scope.md`: what to do and the acceptance criteria, from the ticket or todo, **written for a stranger**: no thread names, todo ids, people, or private reasons; restate any reason in its own terms. Also decide `publicContext` for any workflow that posts: the ticket's text if the ticket is public (a GitHub issue on this repo), otherwise the scope statement.

## Running a workflow

Use the Workflow tool with `name: "dev-work:<workflow>"`. If the name doesn't resolve, use `scriptPath: <this plugin's root>/workflows/<workflow>.js` (the plugin root is two levels above the skill's base directory). If a result is empty or odd, read its `journal.jsonl` (path in the result) before diagnosing. Workflows resume only in the session that started them; in a new session, re-run the phase recorded in the todo.

## Reading commits before a push

`git -C <worktree> log --format='%h %s%n%b' --name-only <base>..HEAD`. Messages and file names only, never diffs. Check that each change matches its task and that no message carries anything private. If one does, have it reworded in the worktree before anything is pushed.

## Reporting to the user

**Success:** the PR link; one line per task or step; rulings made; follow-ups found; counts. Suggest they skim the PR and merge by hand, then tell you.

**Failure:** set Phase: failed (design|operational) and write Outcome first. Then report: the stage; what failed and why; what was tried; **suggested fixes or approaches**; and which restart fits:
- **design** failure → restart clean after adjusting the scope: remove the worktree and branch (ask first), and pass this failure report to the next plan as `failureReport`.
- **operational** failure (a tool, auth, network, a privacy reword) → resume: re-run from the phase in the todo; the worktree, commits and plan are kept.

## After the user merges

When the user says the PR is merged: list the Follow-ups and ask which, if any, to track (as thread todos or tickets: their call; nothing is filed automatically). Then write Outcome, set Phase: done, mark the todo done, and offer to remove the worktree.
