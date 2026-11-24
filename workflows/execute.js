export const meta = {
  name: 'execute',
  description: 'dev-work: plan, build and review a design',
  whenToUse: 'Started by the dev-work develop skill.',
  phases: [{ title: 'Plan' }, { title: 'Tasks' }, { title: 'Final review' }, { title: 'Write-up' }, { title: 'Review feedback' }],
}

// args: { design, inputs, pr_template, base, feedback?, round?, pr?, head?, replan? }
//   design       the design's text, verbatim
//   inputs       [{ name, description }] for files the session staged in .dev-work/inputs/
//   pr_template  the PR template's text
//   base         the commit the branch starts from (40 hex)
//   feedback     for a review round: [{ id, text }] from the PR's review and the user
//   round, pr    the round number and the PR's current description
//   head         for a review round: the branch's commit id before the round
//   replan       to re-plan a branch an earlier run built part of: { source, plan, tasks, rulings, deferred,
//                parked, declined, surfaced, decision, head }. source is 'paused' or 'failed' when the earlier run's result
//                exists, 'saved-plan' when only its plan and the branch do (then tasks, rulings, deferred, parked,
//                declined and surfaced are empty); decision is the decision-log text added since the pause, or ''; head is
//                the branch's current commit. Each planned task comes back kept, revised, new or dropped,
//                and only revised and new tasks are built.
//
// Every agent runs in the session's working directory, the worktree, as a dev-work worker: it gets only
// its prompt, never the threads tools. Everything passes as text in prompts and structured results; no
// file is an interface between agents and no agent exists only to run a command. The run's record is its
// transcript, and a relaunch in the same session replays completed agents.
//
// The implementer, task reviewer, re-reviewer and branch reviewer prompts are adapted from Superpowers
// 7.0.1 (subagent-driven-development's implementer, task-reviewer and re-review templates, and
// requesting-code-review's code-reviewer template), and the planner's from writing-plans (7.0.2): same
// process and wording, with text in and out
// instead of brief, report and diff files. Following later Superpowers changes is a deliberate step.
const A = args
let lastLabel = ''
const ag = (prompt, opts = {}) => { lastLabel = opts.label; return agent(prompt, { agentType: 'dev-work:worker', ...opts }) }
const CAP = 5
const TIERS = ['haiku', 'sonnet', 'opus']
const up = m => TIERS[Math.min(TIERS.indexOf(m) + 1, TIERS.length - 1)]
const effort = m => (m === 'opus' ? 'high' : 'medium')
const atLeast = (m, floor) => TIERS[Math.max(TIERS.indexOf(m), TIERS.indexOf(floor))]

const str = { type: 'string' }, bool = { type: 'boolean' }, int = { type: 'integer' }
const SHA = { type: 'string', pattern: '^[0-9a-f]{40}$', description: 'the full 40-character commit id from `git rev-parse HEAD`, nothing else' }
const obj = (props, req = Object.keys(props)) => ({ type: 'object', properties: props, required: req })
const arr = items => ({ type: 'array', items })
const SEV = { type: 'string', enum: ['Critical', 'Important', 'Minor'] }
const FINDING = obj({ id: str, severity: SEV, text: str, consequence: { type: 'string', description: 'what actually goes wrong, and for whom, if this ships as it is' }, plan_mandated: bool }, ['id', 'severity', 'text', 'consequence'])
const PLAN = obj({ overview: str, global_constraints: str, review_focus: str, assumptions: arr(str), follow_ups: arr(str), tasks: arr(obj({ n: int, title: str, text: str })) })
const DISPOSITIONS = ['kept', 'revised', 'new', 'dropped']
const REPLAN = { ...PLAN, properties: { ...PLAN.properties, tasks: arr(obj({ n: int, title: str, text: str, disposition: { type: 'string', enum: DISPOSITIONS }, reason: str, from: { type: 'integer', description: 'for a kept or revised task, the old plan task number it comes from, as the outcomes list numbers it' } }, ['n', 'title', 'text', 'disposition', 'reason'])) } }
const IMPL = obj({
  status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'] },
  head_sha: SHA,
  summary: { type: 'string', description: 'under 15 lines: commits (short id and subject), a one-line test summary, concerns' },
  report: { type: 'string', description: 'the full report described under Report Format' },
  red: { type: 'string', description: 'the test command and its failing output before you implemented, or "not applicable: " and why' },
}, ['status', 'head_sha', 'summary', 'report', 'red'])
const REVIEW = obj({ spec_verdict: { type: 'string', enum: ['pass', 'fail'] }, cannot_verify: arr(str), quality_verdict: { type: 'string', enum: ['Approved', 'Needs fixes'] }, findings: arr(FINDING) })
const REREVIEW = obj({ results: arr(obj({ id: str, addressed: bool, evidence: { type: 'string', description: 'file:line showing the fix, or the evidence that it should not change' } })), new_findings: arr(FINDING), out_of_scope: arr(str) })
// A finding counts as addressed only with evidence: a bare "addressed" from a quick look doesn't close it.
const closed = rr => new Set(rr.results.filter(r => r.addressed && (r.evidence || '').trim()).map(r => r.id))
const QUESTION = obj({ question: str, reason: { type: 'string', enum: ['expensive to reverse', 'scope creep'] }, why: str, if_guessed: str, options: arr(str), recommendation: str })
const RULINGS = { rulings: arr(str), question: QUESTION }
// The invisible line /dev-work:review reads to tell develop's replies from a person's.
const DEV_MARK = r => `<!-- dev-work:develop round=${r} status=pending_review -->`
const asks = r => !!(r && r.question && typeof r.question.question === 'string' && r.question.question.trim())
const ASKING = `Return a question for the user only when a wrong guess would be expensive to reverse (a large part would have to be rebuilt, or something would ship that loses data or breaks users' trust), or when doing it would be significant scope creep beyond what the design asked for, so the user decides whether it is now or later. Anything cheap to reverse is a ruling, not a question. A question gives the question in plain terms, reason (expensive to reverse or scope creep) and why, if_guessed (what goes wrong if you guess), the options, and your recommendation. Leave question out when you have none.`

// Added to every PR description the workflow writes, so it's always there whatever the template.
const FOOTER = '\n\n---\nWritten by agents with [dev-work](https://github.com/sebmartin/dev-work).'
// A review round is given the PR's current description, which already ends with the footer; strip any before adding one.
// Tolerant of CRLF (a description edited on GitHub comes back with \r\n), a changed link or a missing period.
const FOOTER_RE = /\n*-{3,}[ \t]*\n[ \t]*Written by agents with \[dev-work\]\([^)]*\)\.?[ \t]*/g
const withFooter = body => body.replace(/\r\n/g, '\n').replace(FOOTER_RE, '').trimEnd() + FOOTER
const LOCAL = 'Work only in this checkout, your current directory: commit on the current branch, never push or touch a remote. Add every change as a new commit: never amend, rebase, reset or otherwise rewrite commits, and never force-add ignored files (no `git add -f`). Put any scratch files in .dev-work/scratch/ in this checkout, never anywhere else. Write commit messages for a stranger: what changed and why, in their own terms.'
const NO_SUB = 'Do all of this yourself. Never spawn a subagent to do part of it, and above all never spawn a reviewer to check your work.'
const INPUTS = (A.inputs || []).length ? `\nInput files the design names are in .dev-work/inputs/:\n${A.inputs.map(i => `- .dev-work/inputs/${i.name}: ${i.description}`).join('\n')}` : ''
const wrong = f => f.consequence ? ` What goes wrong: ${f.consequence}` : ''
const fmt = fs => fs.map(f => `- ${f.id} (${f.severity}): ${f.text}${wrong(f)}`).join('\n')
const same = (a, b) => !!a && !!b && a === b

const rulings = [], parked = [], deferred = [], declined = [], surfaced = [], carry = []
const rule = (...lines) => rulings.push(...lines)

// Re-plan mode: the earlier run's rulings and findings carry over, marked as such, and the branch's
// current commit is where building resumes.
const RP = A.replan || null
// A re-plan resumes building from replan.head, so a missing or malformed one fails the run before the
// planner instead of reviewing the wrong range.
const replanHeadOk = !!RP && /^[0-9a-f]{40}$/.test(RP.head || '')
if (RP) {
  rule(...(RP.rulings || []).map(x => `Before the re-plan: ${x}`))
  deferred.push(...(RP.deferred || []).map(x => `before the re-plan: ${x}`))
  parked.push(...(RP.parked || []).map(x => `before the re-plan: ${x}`))
  declined.push(...(RP.declined || []).map(x => `before the re-plan: ${x}`))
  surfaced.push(...(RP.surfaced || []).map(x => `before the re-plan: ${x}`))
}
// A task the re-planner left without a disposition is built: it counts as new, never as kept.
// A task counts as kept only if the earlier run's outcomes show the task it names in `from` built and reviewed
// (done, or kept by an earlier re-plan): a kept task with no `from`, or whose `from` wasn't finished, is built.
// Matching on `from` rather than the task's new number means renumbering can't pair it with a different task.
// With only the saved plan there are no outcomes, so the planner's check of the code is all there is.
// Two kept tasks can't both claim the same earlier task: only the first is accepted.
const firstClaim = t => plan.tasks.find(x => x.disposition === 'kept' && x.from === t.from) === t
const builtBefore = t => RP.source === 'saved-plan' || (Number.isInteger(t.from) && firstClaim(t) && (RP.tasks || []).some(o => o.task === t.from && ['done', 'kept'].includes(o.state)))
const demoted = t => !!RP && t.disposition === 'kept' && !builtBefore(t)
const disposition = t => (RP && DISPOSITIONS.includes(t.disposition) && !demoted(t) ? t.disposition : 'new')
const demotedBecause = t => !Number.isInteger(t.from) ? 'it names no earlier task in from'
  : !firstClaim(t) ? `another kept task already comes from earlier task ${t.from}`
  : `the earlier run does not record task ${t.from} as done`
// Only an earlier task recorded as in progress left partial commits on the branch.
const partlyBuilt = t => Number.isInteger(t.from) && firstClaim(t) && (RP.tasks || []).some(o => o.task === t.from && o.state === 'in progress')
const why = t => `${t.reason || 'no reason given'}${demoted(t) ? `; marked kept, but ${demotedBecause(t)}, so it is built` : ''}`
const skipped = t => ['kept', 'dropped'].includes(disposition(t))

// The run's state, kept where result() can reach it from any ending, including a review round that never plans.
let plan = null, planText = ''
const entries = []            // outcomes of the tasks finished so far
let current = null            // { n, base } of the task in hand
let openNow = null            // { prefix, items }: the findings open in whichever phase is running
let branchHead = replanHeadOk ? RP.head : A.base
const verdicts = []
const outcomes = () => !plan ? [] : plan.tasks.map(t => {
  const done = entries.find(e => e.task === t.n)
  if (done) return done
  if (current && current.n === t.n) return { task: t.n, title: t.title, state: 'in progress', commits: same(current.base, branchHead) ? 'none' : `${current.base.slice(0, 7)}..${branchHead.slice(0, 7)}`,
    review: current.review ? `${current.review}; ${current.open.length} finding(s) open` : 'not reviewed yet' }
  return { task: t.n, title: t.title, state: 'not started' }
})
const replanCounts = () => Object.fromEntries(DISPOSITIONS.map(d => [d, plan.tasks.filter(t => disposition(t) === d).length]))
const result = (status, extra = {}) => {
  // The task in hand has not passed review: the findings still open on it go into the failed result.
  const tasks = outcomes()
  // Whatever is open in the running phase (task, final review or review round) is parked on any failure or pause.
  if (openNow && (status === 'failed' || status === 'paused')) parkOpen(openNow.prefix, openNow.items, status)
  openNow = null
  return { status, head: branchHead, plan: planText, tasks, verdicts, rulings, parked, deferred, declined, surfaced, carried: carry,
    ...(RP && plan ? { replan_counts: replanCounts() } : {}), ...extra }
}
// Findings still open when a question ends the run are parked, so the pause holds them.
const setOpen = (prefix, items) => { openNow = items && items.length ? { prefix, items } : null }
const parkOpen = (prefix, open, how = 'paused') => open.forEach(f => parked.push(`${prefix} ${f.id}: ${f.text}${wrong(f)} (open when the run ${how})`))
// What the breakers surfaced for a human is parked too when a later question pauses the run.
const parkSurfaced = () => surfaced.splice(0).forEach(x => parked.push(`${x} (surfaced for a human; open when the run paused)`))
const pause = (question, at, extra = {}) => result('paused', { at, question, ...extra })
// A pause with no question from an agent: the run says what it could not settle.
const plainQuestion = (question, ifGuessed) => ({ question, reason: 'expensive to reverse', why: 'the run could not settle this without guessing', if_guessed: ifGuessed, options: [], recommendation: '(none given)' })

// ---------- Prompts ----------
const implementerPrompt = ({ n, title, text, context, constraints, applicable, fix }) => `You are implementing Task ${n}: ${title}

## Task Description

${text}

## Context

${context}

Global constraints from the design and plan that bind this task:
${constraints}
${applicable.length ? `\nRulings made in this run that bind your work (the design is the binding authority; these settle what it and the plan left open):\n${applicable.join('\n')}\n` : ''}${INPUTS}
## Your Job

1. Implement exactly what the task specifies
2. Write tests (following TDD if the task says to: write the failing test, run it and see it fail for the expected reason, then implement)
3. Verify implementation works
4. Commit your work
5. Self-review (see below)
6. Report back

Nobody will answer questions while you work. If something is unexpected or unclear, don't guess on anything that matters: report NEEDS_CONTEXT or BLOCKED (below) with the specifics.

While iterating, run the focused test for what you're changing; run the full suite once before committing, not after every edit.

${LOCAL}

## You Do Not Dispatch Subagents

${NO_SUB} Self-review (below) means reading your own diff. Review is the controller's job: after you report, a fresh reviewer checks your diff. A reviewer you spawn duplicates that review at full cost, and its approval counts for nothing.

## Code Organization

- Follow the file structure defined in the plan
- Each file should have one clear responsibility with a well-defined interface
- If a file you're creating is growing beyond the plan's intent, stop and report it as DONE_WITH_CONCERNS; don't split files on your own without plan guidance
- If an existing file you're modifying is already large or tangled, work carefully and note it as a concern in your report
- In existing codebases, follow established patterns. Improve code you're touching the way a good developer would, but don't restructure things outside your task.

## When You're in Over Your Head

It is always OK to stop and say "this is too hard for me." Bad work is worse than no work. You will not be penalized for escalating.

STOP and escalate when:
- The task requires architectural decisions with multiple valid approaches
- You need to understand code beyond what was provided and can't find clarity
- You feel uncertain about whether your approach is correct
- The task involves restructuring existing code in ways the plan didn't anticipate
- You've been reading file after file trying to understand the system without progress

How to escalate: return status BLOCKED or NEEDS_CONTEXT, and say in the report specifically what you're stuck on, what you've tried, and what kind of help you need. Before you do, leave the working tree clean: commit what is worth keeping (say in the commit message that it is unfinished) and discard the rest. Only committed work survives a pause.

## Before Reporting Back: Self-Review

Review your work with fresh eyes:
- Completeness: did I fully implement everything in the task? Did I miss any requirements? Are there edge cases I didn't handle?
- Quality: is this my best work? Are names clear and accurate? Is the code clean and maintainable?
- Discipline: did I avoid overbuilding (YAGNI)? Did I only build what was requested? Did I follow existing patterns?
- Testing: do tests verify behavior, not mocks? Did I follow TDD if required? Is the test output pristine?

If you find issues during self-review, fix them now before reporting.
${fix ? `\n## Fix Round\n\n${fix}\n` : ''}
## Report Format

Return your report in the report field (not in a file):
- What you implemented (or attempted, if blocked)
- What you tested and the test results
- TDD evidence, if the task required TDD: RED: the command, the relevant failing output before implementation, and why the failure was expected; GREEN: the command and the relevant passing output after
- Files changed
- Self-review findings, if any
- Any issues or concerns

Return in red the failing run that shows your new tests check the new code: the command and the relevant failing output, captured before you implemented. If no test could fail first (the task changes no behaviour, or it is a fix with no new test), write "not applicable: " and why.

Return in summary, under 15 lines: the commits created (short id and subject), a one-line test summary, and your concerns. head_sha is the full commit id from \`git rev-parse HEAD\` when you finish.

Use DONE_WITH_CONCERNS if you completed the work but have doubts about correctness. Use BLOCKED if you cannot complete the task. Use NEEDS_CONTEXT if you need information that wasn't provided. Never silently produce work you're unsure about.`

const TRACE = 'Before you rate a finding Minor or call it harmless, and for anything the change removes, moves or recreates (a file, a directory, a worktree, saved state), trace what later reads or relies on it, in this change and in the code around it. Ask what breaks because it is gone, not only whether anything is lost.'
const diffCommands = (from, to) => `\`git log --oneline ${from}..${to}\`, \`git diff --stat ${from}..${to}\` and \`git diff ${from}..${to}\``

const taskReviewerPrompt = ({ n, title, text, constraints, report, concerns, base, head, evidenceOnly, revising }) => `You are reviewing one task's implementation: first whether it matches its requirements, then whether it is well-built. This is a task-scoped gate, not a merge review; a broad whole-branch review happens separately after all tasks are complete.

## What Was Requested

Task ${n}: ${title}

${text}

Global constraints from the design and plan that bind this task:
${constraints}
${revising ? `${revising}\n\nBecause this task revises code already on the branch before Base, a requirement that code already on the branch meets is not Missing, and a listed file the diff never touches is not a Missing finding for that reason alone: put such requirements in cannot_verify, so they are checked in the code.\n` : ''}
## What the Implementer Claims They Built

${report}
${concerns ? `\nThe implementer reported concerns; judge them with the rest: ${concerns}\n` : ''}
## Diff Under Review

${evidenceOnly ? `This task made no commits, so there is no diff. Review the report and any evidence files it names against the task instead: were the required steps run, and do the recorded results support what the report claims?` : `Base: ${base}
Head: ${head}

Read the change once with ${diffCommands(base, head)}. That is your view of the change. The diff's context lines are the changed files: don't read a changed file separately unless a hunk you must judge is cut off mid-function, and say so. Don't crawl the broader codebase. Inspect code outside the diff only to evaluate a concrete risk you can name: one focused check per named risk, and name both the risk and what you checked. Cross-cutting changes are legitimate named risks: if the diff changes lock ordering, a function or API contract, or shared mutable state, checking the call sites is the right method.`}

Your review is read-only on this checkout. Do not mutate the working tree, the index, HEAD, or branch state in any way.

## You Do Not Dispatch Subagents

Do all of this review yourself. Never spawn a subagent to review part of the diff, and never spawn another reviewer for a second opinion. If the diff feels too large for one pass, review it in passes yourself.

## Do Not Trust the Report

Treat the implementer's report as unverified claims about the code. It may be incomplete, inaccurate, or optimistic. Verify the claims against the diff. Design rationales in the report are claims too: "left it per YAGNI," "kept it simple deliberately," or any other justification is the implementer grading their own work. Judge the code on its merits; a stated rationale never downgrades a finding's severity.

## Tests

The implementer already ran the tests and reported results with TDD evidence for exactly this code. Don't re-run the suite to confirm their report. Run a test only when reading the code raises a specific doubt that no existing run answers, and then a focused test, never a package-wide suite, race detector run, or repeated loop. If heavy validation seems warranted, recommend it instead of running it.

Warnings or other noise in the implementer's reported test output are findings: test output should be pristine. If the report's test evidence is missing, report that as a gap.

## Part 1: Spec Compliance

Compare the diff against What Was Requested:
- Missing: requirements they skipped, missed, or claimed without implementing
- Extra: features that weren't requested, over-engineering, unneeded "nice to haves"
- Misunderstood: right feature built the wrong way, wrong problem solved

If the task lists several files each with its own change, check the diff against that list file by file: a listed file the diff never touches is a Missing finding.

If a requirement cannot be verified from this diff alone (it lives in unchanged code or spans tasks), put it in cannot_verify instead of broadening your search.

## Part 2: Code Quality

- Code quality: clean separation of concerns? Proper error handling? DRY without premature abstraction? Edge cases handled?
- Tests: do the new and changed tests verify real behavior, not mocks? Are the task's edge cases covered?
- Structure: does each file have one clear responsibility with a well-defined interface? Are units decomposed so they can be understood and tested independently? Is the implementation following the file structure from the plan? Did this change create new files that are already large, or significantly grow existing files?

Point at evidence: file:line for every finding.

## Calibration

For every finding, ask what actually goes wrong, and for whom (a person or an agent using the software), if this ships as it is, and write the answer in consequence. A finding where something real goes wrong is Critical or Important and is fixed in this task, never Minor. Minor is only for findings where nothing goes wrong for anyone.

Categorize issues by actual severity. Not everything is Critical. Important means this task cannot be trusted until it is fixed: incorrect or fragile behavior, a missed requirement, or maintainability damage you would block a merge over (verbatim duplication of a logic block, swallowed errors, tests that assert nothing). "Coverage could be broader" and polish suggestions are Minor. If the plan or task explicitly mandates something this rubric calls a defect, that is a finding: report it as Important with plan_mandated set. Acknowledge what was done well before listing issues; accurate praise helps the implementer trust the rest.

## Output

spec_verdict: pass or fail. cannot_verify: the requirements you couldn't verify from the diff alone, each saying what should be checked. quality_verdict: Approved or Needs fixes. findings: each with an id T${n}-1, T${n}-2 and so on, its severity, and the text: file:line, what's wrong, why it matters, how to fix it if not obvious. Each finding also has its consequence: what goes wrong, and for whom.`

const reReviewPrompt = ({ task, findings, reports, fixBase, head, idPrefix }) => `You are re-reviewing a fix round. A previous review produced findings; an implementer has attempted to fix them. Your job is to verdict each finding and inspect the fix diff, nothing else.

## The Task

${task}

## The Findings Under Verification

${findings}

## The Fix

The implementer's reports, latest last:

${reports}

Fix base: ${fixBase} (the head the previous review saw)
Head: ${head}

Read the fix once with ${diffCommands(fixBase, head)}. If there are no commits after the fix base, verify the findings from the reports and any files they name.

Your review is read-only on this checkout. Do not mutate the working tree, the index, HEAD, or branch state in any way. Do all of this review yourself; never spawn a subagent.

## Scope

Your scope is the findings list and the fix diff. Verdict every finding. Inspect the fix diff for new problems the fix itself introduced. Don't re-review code the fix didn't touch: an issue entirely outside the fix diff goes in out_of_scope; it doesn't block and doesn't extend the loop.

A finding counts as addressed if the specific defect no longer exists, or if the report shows with evidence that it should not change. "Attempted" is not addressed.

## Tests

The implementer re-ran the tests covering the amended code and reported the results. Treat the report as unverified claims: confirm it names the covering tests and shows their output, and verify the claims against the diff. Don't re-run the suite; run a focused test only for a specific doubt no existing run answers.

## Output

results: each finding's id, addressed true or false, and evidence: the file:line that shows it fixed, or the report's evidence that it should not change. A finding with no evidence stays open. new_findings: anything the fix itself broke or introduced, with severity and file:line, ids ${idPrefix}1, ${idPrefix}2 and so on. For each one, ask what actually goes wrong, and for whom (a person or an agent using the software), if this ships as it is, and write the answer in consequence. A finding where something real goes wrong is Critical or Important, never Minor; Minor is only for findings where nothing goes wrong for anyone. out_of_scope: issues entirely outside the fix diff.`

const branchReviewerPrompt = ({ planText, base, head, triage }) => `You are a Senior Code Reviewer with expertise in software architecture, design patterns, and best practices. Your job is to review completed work against its design and plan and identify issues before it merges.

## What Was Implemented

The change implementing the plan below, on the current branch.

## The Design

${A.design}

## The Plan

${planText}

## Git Range to Review

Base: ${base}
Head: ${head}

Read it with \`git diff --stat ${base}..${head}\` and \`git diff ${base}..${head}\`.

## The spec is a vision document

The design says what the software must do. It does not enumerate every input, environment, or condition the software will meet. For behavior it is silent on, judge by what a reasonable person using this software would expect: a reasonable person's expectation is a requirement, and silence is not permission. Grade such findings by their effect on that person.

## Read-Only Review

Your review is read-only on this checkout. Do not mutate the working tree, the index, HEAD, or branch state in any way. If you need a working copy of a different revision, check it out into a separate temporary directory with \`git worktree add\`; never move HEAD on this checkout. Do all of this review yourself; never spawn a subagent.

## What to Check

- Plan alignment: does the implementation match the plan and design? Are deviations justified improvements or problematic departures? Is all planned functionality present? Flag significant deviations specifically, and if you find issues with the plan itself rather than the implementation, say so.
- Code quality: separation of concerns, error handling, type safety, DRY without premature abstraction, edge cases.
- Architecture: sound design decisions, reasonable performance, security concerns, clean integration with surrounding code.
- Testing: tests verify real behavior, edge cases covered, integration tests where they matter, all tests passing.
- Production readiness: migration strategy if schema changed, backward compatibility, documentation, no obvious bugs.
- ${TRACE}

## Declined to Judge

Before your verdict, list every behavior you considered and set aside as outside the plan or design, one line each, with the reason. Nothing you set aside is dropped silently: each line goes to an independent check that fixes it, defers it with a reason, or asks the user. An empty list means you set nothing aside.

## Earlier Findings to Triage

These were deferred as Minor or parked during the task reviews. Set must_fix on any that must be fixed before merge, as a Minor finding if it isn't already one:
${triage || '(none)'}

## Calibration

Categorize issues by actual severity: Critical (bugs, security issues, data loss risks, broken functionality), Important (architecture problems, missing features, poor error handling, test gaps), Minor (style, optimization, documentation polish). Not everything is Critical. Be specific (file:line), explain why each issue matters, and give a clear verdict.

## Output

summary: your assessment and its reasoning, including what's done well, and your recommendations. declined: the Declined to Judge lines. ready: Yes, No or With fixes. findings: ids F-1, F-2 and so on, each with severity, must_fix where it applies, and the text: file:line, what's wrong, why it matters, how to fix it.`

// The ruler makes the calls Superpowers leaves to its controller.
const ruler = (question, schema, label, phase) => ag(`You make the judgment calls a person would make while a plan is built task by task by implementer and reviewer agents, for the run building the design below. The design is the binding authority, the plan is its argument, and your judgment settles what neither answers. Read the code as needed; don't change it.

## The Design

${A.design}
${planText ? `\n## The Plan\n\n${planText}\n` : ''}
## Rulings so far

${rulings.join('\n') || '(none)'}

## The Question

${question}

Write every decision as "Ruling: <what you decided>; why: <why>; cost if wrong: <what it costs if wrong>". Decide everything that is cheap to reverse; nobody answers questions while the run is going. ${ASKING}`,
  { label, phase, schema, model: 'opus', effort: 'high' })

// Fix rounds on a set of findings: a fresh implementer per round (rounds 1-3 on the given model, 4-5 one
// tier up), each followed by a scoped re-review. Returns the findings still open and the new head.
const fixLoop = async ({ open, head, model, label, phase, fixPrompt, task, idPrefix, onDeferred, onRound, track = () => {} }) => {
  const reports = []
  track(open)
  for (let round = 1; open.length && round <= CAP; round++) {
    const fixBase = head, fixModel = round <= 3 ? model : up(model)
    const fix = await ag(fixPrompt(round, reports, open), { label: `${label}-fix-r${round}`, phase, schema: IMPL, model: fixModel, effort: effort(fixModel) })
    if (!fix) return { open, head, failed: `${label} fix round ${round}` }
    head = branchHead = fix.head_sha
    reports.push(`Fix round ${round}:\n${fix.report}`)
    const rr = await ag(reReviewPrompt({ task, findings: fmt(open), reports: reports.join('\n\n'), fixBase, head, idPrefix: `${idPrefix}R${round}-` }),
      { label: `${label}-re-review-r${round}`, phase, schema: REREVIEW, model: 'sonnet', effort: 'medium' })
    if (!rr) return { open, head, failed: `${label} re-review round ${round}` }
    // A finding counts as addressed only if the re-review says so: one it skips stays open.
    const addressed = closed(rr)
    rr.new_findings.filter(f => f.severity === 'Minor').map(f => `${f.id} ${f.text}`).concat(rr.out_of_scope).forEach(onDeferred)
    const before = open.length
    open = open.filter(f => !addressed.has(f.id)).concat(rr.new_findings.filter(f => f.severity !== 'Minor'))
    track(open)
    onRound(round, before - (open.length - rr.new_findings.filter(f => f.severity !== 'Minor').length), open.length, fixBase, head)
    // A fix agent that couldn't proceed ends the loop; the breaker rules on what's left.
    if (fix.status === 'BLOCKED' || fix.status === 'NEEDS_CONTEXT') { open = open.map(f => ({ ...f, text: `${f.text} (the fix agent reported ${fix.status}: ${fix.summary})` })); track(open); break }
  }
  return { open, head }
}

// The breaker: adjudicate findings still open after the cap.
const breaker = async (context, open, choices, label, phase) => {
  const r = await ruler(`${context} Adjudicate each open finding: park it (the reviewer is wrong or the point is contestable, or it is real but nothing downstream builds on it), or ${choices === 'carry' ? 'if it is real and load-bearing, rule on the smallest change that unblocks the dependent work; that ruling is carried into later tasks' : 'if it is real and load-bearing, rule on it; those are surfaced to the user'}.
${fmt(open)}`,
    obj({ decisions: arr(obj({ id: str, decision: { type: 'string', enum: ['park', choices] }, ruling: str })), ...RULINGS }, ['decisions', 'rulings']), label, phase)
  if (r) {
    const decided = new Set(r.decisions.map(d => d.id))
    open.filter(f => !decided.has(f.id)).forEach(f => r.decisions.push({ id: f.id, decision: choices === 'carry' ? 'carry' : 'surface', ruling: 'No ruling was returned for this finding; it stays open.' }))
  }
  return r
}

// ---------- The deferral check ----------
// Everything headed for "not fixed" gets an independent look before anything is published: the reviewer
// that labelled a finding and the session that wants to finish both have a stake in deferring it.
const DEFERRAL = obj({ items: arr(obj({ id: str, consequence: str, verdict: { type: 'string', enum: ['resolve', 'defer', 'fixed'] }, needs_user: bool, reason: str })), question: QUESTION }, ['items'])
const deferralCheck = async (head, phaseName) => {
  const items = [...deferred.map(x => ({ from: 'deferred', text: x })), ...parked.map(x => ({ from: 'parked', text: x })), ...declined.map(x => ({ from: 'declined', text: x }))].map((x, i) => ({ id: `D-${i + 1}`, ...x }))
  if (!items.length) return { head }
  const c = await ag(`Findings from this run are about to be left out of the pull request: deferred as minor, set aside by the final review as outside the plan or design (declined), or parked. Each was set aside by whoever found it, and nobody has checked that call. Check it.

## The Design

${A.design}

## The Findings

${items.map(i => `- ${i.id} (${i.from}): ${i.text}`).join('\n')}

For each finding, read the code it points at and work out what actually goes wrong, and for whom, if this branch ships as it is: a person or an agent using the software, not the code's tidiness. Write that in consequence, concretely, or "nothing goes wrong" with why. Then:
- verdict resolve when something real goes wrong: content lost or silently overwritten, the software not doing what the design says, or an agent steered into doing the wrong thing. Set needs_user when fixing it needs the user's decision: the fix would contradict the design, or the conditions below for asking hold.
- verdict defer when nothing concrete goes wrong, and say why in reason.
- verdict fixed when the branch has already fixed it (a later fix may have), with the evidence in reason.
${TRACE}
Read only.

${ASKING} Ask one question covering every finding with needs_user.`,
    { label: `deferral-check`, phase: phaseName, model: 'opus', effort: 'high', schema: DEFERRAL })
  if (!c) return { head, failed: 'deferral check' }
  const byId = Object.fromEntries(items.map(i => [i.id, i.text])), fromId = Object.fromEntries(items.map(i => [i.id, i.from]))
  const decided = new Set(c.items.map(x => x.id))
  // A finding the check skipped is treated as needing resolution: it fails closed.
  items.filter(i => !decided.has(i.id)).forEach(i => c.items.push({ id: i.id, consequence: 'not assessed', verdict: 'resolve', needs_user: false, reason: 'the check returned no verdict' }))
  c.items.filter(x => byId[x.id] !== undefined).forEach(x => verdicts.push({ id: x.id, from: fromId[x.id], text: byId[x.id], consequence: x.consequence, verdict: x.verdict, needs_user: !!x.needs_user, reason: x.reason }))
  const mine = c.items.filter(x => x.verdict === 'resolve' && x.needs_user && byId[x.id] !== undefined)
  const fixList = c.items.filter(x => x.verdict === 'resolve' && !x.needs_user && byId[x.id] !== undefined).map(x => ({ id: x.id, severity: 'Important', text: `${byId[x.id]} What goes wrong if shipped: ${x.consequence}` }))
  const listFor = x => (fromId[x.id] === 'parked' ? parked : fromId[x.id] === 'declined' ? declined : deferred)
  deferred.length = 0; parked.length = 0; declined.length = 0
  c.items.filter(x => x.verdict === 'defer' && byId[x.id] !== undefined).forEach(x => listFor(x).push(`${byId[x.id]} (left out because: ${x.reason})`))
  mine.forEach(x => listFor(x).push(`${byId[x.id]} (needs the user's decision: ${x.consequence})`))
  const askUser = () => (asks(c) ? c.question : plainQuestion(`These findings would cause real harm if shipped, and fixing them needs your decision:\n${mine.map(x => `- ${byId[x.id]}\n  What goes wrong: ${x.consequence}`).join('\n')}`, 'the harm ships, or the fix goes beyond what the design asked for'))
  if (!fixList.length) return mine.length ? { head, question: askUser() } : { head }
  // Keep each finding to be fixed in its own list until the re-review closes it, so a failure in between
  // (a throw, a null return) still hands it to the next run.
  const pending = c.items.filter(x => x.verdict === 'resolve' && !x.needs_user && byId[x.id] !== undefined).map(x => ({ list: listFor(x), entry: `${byId[x.id]} (judged harmful by the deferral check; fix pending)` }))
  pending.forEach(p => p.list.push(p.entry))
  const fix = await ag(`Fix these findings before this branch is published. Each was going to be left out; a check found it causes real harm. Re-run the tests that cover what you change, and commit. ${LOCAL} ${NO_SUB}

## The Design

${A.design}

## Rulings Made in This Run

${rulings.join('\n') || '(none)'}

## The Findings

${fmt(fixList)}

Return in report what changed per finding, the covering tests, the command and the output. head_sha is the full commit id from \`git rev-parse HEAD\` when you finish.`,
    { label: 'deferral-fix', phase: phaseName, schema: IMPL, model: 'sonnet', effort: 'medium' })
  if (!fix) return { head, failed: 'deferral fix' }
  branchHead = fix.head_sha
  const rr = await ag(reReviewPrompt({ task: 'Findings that were going to be left out of the pull request, fixed because they cause real harm.', findings: fmt(fixList), reports: fix.report, fixBase: head, head: fix.head_sha, idPrefix: 'D-R-' }),
    { label: 'deferral-re-review', phase: phaseName, schema: REREVIEW, model: 'sonnet', effort: 'medium' })
  if (!rr) return { head: fix.head_sha, failed: 'deferral re-review' }
  pending.forEach(p => { const i = p.list.indexOf(p.entry); if (i >= 0) p.list.splice(i, 1) })
  const addressed = closed(rr)
  const left = fixList.filter(f => !addressed.has(f.id)).concat(rr.new_findings.filter(f => f.severity !== 'Minor'))
  rr.new_findings.filter(f => f.severity === 'Minor').map(f => `${f.id} ${f.text}`).concat(rr.out_of_scope).forEach(x => deferred.push(`${x} (found after the deferral check, not assessed)`))
  left.forEach(f => deferred.push(`${f.text} (still open after the deferral fix)`))
  if (mine.length) return { head: fix.head_sha, question: askUser(), fixed: fix.report }
  if (left.length) return { head: fix.head_sha, question: plainQuestion(`These findings cause real harm and are still open after a fix:\n${fmt(left)}`, 'the harm ships in the pull request') }
  return { head: fix.head_sha, fixed: fix.report }
}

// The run, wrapped so that an agent call that throws (a usage limit, an expired login) still ends with a
// failed result carrying the state above. The body keeps its indentation to keep the diff readable.
const main = async () => {
// ---------- Review feedback: fix rounds on a review of the PR, then the replies ----------
if (A.feedback) {
  phase('Review feedback')
  branchHead = A.head || A.base
  const R = A.round || 1
  let open = A.feedback.map((f, i) => ({ id: f.id || `PR${R}-${i + 1}`, severity: 'Important', text: f.text }))
  const task = `Review round ${R} on the pull request for this branch. The design:\n\n${A.design}\n\nThe pull request's description:\n\n${A.pr || '(none)'}`
  const outcome = {}
  const loop = await fixLoop({
    open, head: A.head, model: 'sonnet', label: `round-${R}`, phase: 'Review feedback', task, idPrefix: `PR${R}-`,
    fixPrompt: (round, reports, items) => `A reviewer left this feedback on the pull request for this branch. ${round <= 3 ? `Fix round ${round} of ${CAP}.` : `Earlier attempts are below; you own the remaining items now.`}

## The Design

${A.design}

## The Pull Request's Description

${A.pr || '(none)'}

Read what the branch changes with \`git diff ${A.base}..HEAD\` as needed.${INPUTS}
${reports.length ? `\n## Earlier Fix Reports\n\n${reports.join('\n\n')}\n` : ''}
## The Feedback

${fmt(items)}

Address each item, re-run the tests that cover what you change, and commit. If an item is wrong or would contradict the design, don't change code for it: explain why in your report. ${LOCAL} ${NO_SUB}

Return in report, per item: what changed, or why nothing should change, with evidence; the covering tests, the command and the output. head_sha is the full commit id from \`git rev-parse HEAD\` when you finish, whether or not you committed.`,
    onDeferred: t => deferred.push(`round ${R} ${t}`),
    onRound: () => {},
    track: o => setOpen(`round ${R}`, o),
  })
  if (loop.failed) return result('failed', { stage: loop.failed })
  A.feedback.forEach((f, i) => { const id = f.id || `PR${R}-${i + 1}`; if (!loop.open.find(o => o.id === id)) outcome[id] = 'addressed' })
  if (loop.open.length) {
    const r = await breaker(`Review round ${R} on the pull request hit its cap of ${CAP} fix rounds.`, loop.open, 'surface', 'round-breaker', 'Review feedback')
    if (!r) return result('failed', { stage: 'round breaker' })
    rule(...r.rulings.map(x => `Round ${R}: ${x}`))
    if (asks(r)) return pause(r.question, `round ${R}`, { round: R, feedback: A.feedback })
    setOpen()
    for (const d of r.decisions) {
      const f = loop.open.find(x => x.id === d.id) || { id: d.id, text: '' }
      outcome[d.id] = `${d.decision}: ${d.ruling}`
      if (d.decision === 'park') { rule(`Round ${R}: parked: ${f.id} ${f.text}; ruling: ${d.ruling}`); parked.push(`round ${R} ${f.id}: ${f.text}; ruling: ${d.ruling}`) }
      else { rule(`Round ${R}: ${d.ruling}`); surfaced.push(`${f.id}: ${f.text}; ruling: ${d.ruling}`) }
    }
  }
  const dc = await deferralCheck(loop.head, 'Review feedback')
  if (dc.failed) return result('failed', { stage: dc.failed })
  if (dc.question) { parkSurfaced(); return pause(dc.question, `round ${R} deferral check`, { round: R, feedback: A.feedback }) }
  loop.head = dc.head
  phase('Write-up')
  const w = await ag(`Write the replies to a review of a pull request, for a reader who knows only the pull request. Read what the round changed with \`git log\` and \`git diff\` on this branch as needed; change nothing.

## The Pull Request's Description

${A.pr || '(none)'}

## The Feedback and What Happened

${A.feedback.map((f, i) => { const id = f.id || `PR${R}-${i + 1}`; return `- ${id}: ${f.text}\n  Outcome: ${outcome[id] || 'open'}` }).join('\n')}

## The Round's Rulings

${rulings.filter(x => x.startsWith(`Round ${R}`)).join('\n') || '(none)'}

For each item, write one reply of one or two lines, standing on its own, that starts with what happened:
- "Fixed in <short commit id>: <what changed>. Test: <name>." when it was fixed;
- "Not changed: <the reason, concrete>." when it wasn't;
- "Partly: <what was done, and what wasn't and why>." when only some of it was;
- "Question: <what's unclear>." when the item can't be acted on as written.
No thanks, no apologies, and don't restate the comment; disagree with evidence, not tone. If the round changed anything the description says, return the whole updated description in pr_body, without the footer at its end (one is added for you); otherwise return pr_body empty.`,
    { label: `round-${R}-write-up`, phase: 'Write-up', model: 'sonnet', effort: 'medium', schema: obj({ replies: arr(obj({ id: str, reply: str })), pr_body: str }) })
  if (!w) return result('failed', { stage: 'round write-up' })
  return result('done', { pr_status: 'pending_review', final_head: loop.head, round: R, outcome, surfaced, replies: w.replies.map(x => ({ ...x, reply: `${x.reply.trimEnd()}\n\n${DEV_MARK(R)}` })), pr_body: w.pr_body ? withFooter(w.pr_body) : '' })
}

// ---------- Plan ----------
if (RP && !replanHeadOk) return result('failed', { stage: 're-plan', error: `replan.head must be the branch's full 40-character commit id; got ${JSON.stringify(RP.head)}` })
// In re-plan mode the planner also gets what the earlier run built and why the design changed.
const listed = xs => (xs || []).map(x => `- ${x}`).join('\n') || '(none)'
const outcomeLine = o => `- Task ${o.task}: ${o.title}: ${o.state}${o.commits ? `, commits ${o.commits}` : ''}${o.review ? `, review ${o.review}` : ''}${o.reason ? `, ${o.reason}` : ''}`
const replanSection = !RP ? '' : `
## Re-plan

This design was planned and partly built before, on this branch. ${RP.source === 'failed'
  ? `The earlier run failed for an operational reason, not because of the design.${RP.decision ? ` The design was changed before it, by this decision:\n\n${RP.decision}` : ' The design is unchanged.'}`
  : `The old plan below was built for a design that turned out to be missing something. What changed:\n\n${RP.decision || '(no decision was recorded; compare the old plan with the design above)'}`}

Nothing in the old plan is reused by default: every task, built or not, has to be justified again against the updated design. Plan from the updated design first, then check the old plan for what still holds. Mark every task in your plan with a disposition and its reason:
- kept: already built and still right. It is not built again. Give it \`from\`, the old plan's task number as the outcomes below list it: only a task whose \`from\` the earlier run's outcomes show as done (or kept) is accepted as kept, and any other is built.
- revised: built, but needs changing. It is built again, as a change to what is on the branch.
- new: not in the old plan, or in it but not built yet. Unbuilt tasks that still hold are reused as written and marked new.
- dropped: no longer wanted. Its code, if it is on the branch, is removed as part of a revised or new task; say which.

What was built is the branch's commits from ${A.base} up to ${RP.head}: read them with ${diffCommands(A.base, RP.head)}.
${RP.source === 'saved-plan' ? `
No result of the earlier run exists, only its plan and the branch, so every task is unverified. Keep a task only after checking the code on the branch against it, and say in its reason what you checked.

### The Old Plan

${RP.plan}
` : `
### The Old Plan

${RP.plan}

### Each Task's Outcome

${(RP.tasks || []).map(outcomeLine).join('\n') || '(none)'}

A task shown "in progress" was being built when the run ended and has not passed review: its commits may be code a reviewer rejected, or code nobody reviewed. Its open findings, if any, are in the Parked list below, marked open when the run paused or failed. Don't keep such a task without checking its code on the branch against its requirements and those findings, and say in its reason what you checked.

### Rulings Made in the Earlier Run

${listed(RP.rulings)}

### Findings Left Open

Deferred:
${listed(RP.deferred)}

Parked:
${listed(RP.parked)}

Set aside by the final review as outside the plan (declined):
${listed(RP.declined)}
`}
The branch's head: ${RP.head}
`
phase('Plan')
const planned = await ag(`Write the implementation plan for the design below, for an engineer who has not seen this codebase or this design. Assume they write idiomatic code in the project's language once they know the exact interface and the exact test, and that they will make a reasonable choice wherever the plan leaves one open. What they cannot know is what you decided: which files, which names and signatures, which values from the design, which tests prove each task. Document those. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Read the code as you need to, and run the repository's existing commands, but don't write or run new code.

- The design is decided: plan it, don't redesign it. Plan only what it asks; anything else goes under Follow-ups.
- Nobody will answer questions. Make the call and record it under Assumptions.
- If the design covers several independent subsystems, plan them in order anyway, each producing working, testable software, and say so under Assumptions.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure, but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a fresh reviewer's gate. Fold setup, configuration, scaffolding and documentation steps into the task whose deliverable needs them; split only where a reviewer could meaningfully reject one task while approving its neighbor. Each task ends with an independently testable deliverable.

## Step Granularity

Each step is one action with a checkable result: write the failing test; run it to make sure it fails; implement the minimal code to make the test pass; run the tests and make sure they pass; commit.

## The Overview

Everything before the first task:
- a title, then **Goal** (one sentence), **Architecture** (2-3 sentences about the approach) and **Tech Stack**;
- **Global Constraints:** the design's project-wide requirements (version floors, dependency limits, naming and copy rules, platform requirements), one line each, with exact values copied verbatim from the design. Every task's requirements implicitly include this section.
- **Review Focus:** the five input classes or failure modes the design implies but no task's tests exercise that are most likely to bite a person using this software, one line each, naming the input or condition and the behavior a reasonable person would expect, most likely first. The design says what the software must do, not everything it will meet, and its silence on an input is not permission for that input to break the program. For each line, add the test that pins it to the task that owns the code.
- the file structure.

## Each Task

Its title, then:
- **Files:** each file to create, modify (with line ranges) or test, by exact path.
- **Interfaces:** what this task consumes from earlier tasks (exact signatures) and what it produces that later tasks rely on (exact names, parameter and return types). A task's implementer sees only their own task; this block is how they learn the names and types neighboring tasks use.
- Numbered checkbox steps, in this shape: write the failing test (its name and assertions, as code); run it to verify it fails (the command, and the failure expected); implement (the exact signature and file, with one line on the approach when the signature and the test leave a choice); run it to verify it passes (the command, and PASS); commit (the files and a message that says what changed and why, for a stranger).

## What a Step Contains

A step is done when the implementer can write exactly one reasonable thing from it. That is the whole requirement: unambiguous, not complete.
- A test step: the test's name and its assertions, as code, with the design's exact values in them.
- A code step: the exact signature (name, parameters, return type), the file it lives in, and the specific values the design pins. The implementer writes the body. A body appears only for an algorithm the signature and tests do not determine, or for exact copy the design fixes.
- A verification step: the command to run and the output that means it passed.
- A reference to another task: that task's Interfaces block says what to use; the plan does not repeat that task's code.

A plan is the set of decisions the implementer cannot make alone. A plan longer than the code it describes has written the code instead. Lines that decide nothing ("TBD", "handle edge cases", "add appropriate validation", "write tests for the above", a type or function no task defines) are the opposite failure.

## Self-Review

After writing the complete plan, look at the design with fresh eyes and check the plan against it yourself:
1. Design coverage: can you point to a task that implements each requirement? Add a task for any that has none.
2. Step scan: every step lets the implementer write exactly one reasonable thing, and no step carries more than that. Fix lines that decide nothing, and bodies the signature and tests already determine.
3. Type consistency: do the types, signatures and names in later tasks match what earlier tasks defined?
4. Review Focus: for each input class or failure mode the design implies, is there a task whose tests exercise it? An empty section means you checked and found none.
5. Proportion: a plan several times longer than the design it implements is a transcript of the program. If code blocks are most of it, replace bodies with signatures, test names and assertions.

Fix what you find inline.
${INPUTS}

## The Design

${A.design}
${replanSection}
## Return

Write the full plan, overview and tasks, to .dev-work/implementation-plan.md in this checkout, for the user to read while the work runs; nothing reads it back.${RP ? ' Give each task\'s disposition and reason under its title.' : ''} Then return it, as below.

- overview: everything in the plan before the first task (title, Goal, Architecture, Tech Stack, Global Constraints, Review Focus, file structure).
- global_constraints and review_focus: those two sections' text.
- assumptions and follow_ups: one entry each.
- tasks: in order, each with its number, its title and its full text, exactly as the plan has it${RP ? ', its disposition (kept, revised, new or dropped), its reason, and for a kept or revised task \`from\`, the old plan task number it comes from' : ''}.`,
  { label: 'plan', phase: 'Plan', model: 'opus', effort: 'medium', schema: RP ? REPLAN : PLAN })
if (!planned) return result('failed', { stage: 'plan' })
plan = planned
planText = `${plan.overview}\n\n${plan.tasks.map(t => `### Task ${t.n}: ${t.title}${RP ? ` (${disposition(t)}: ${why(t)})` : ''}\n\n${t.text}`).join('\n\n')}`
// Kept and dropped tasks are recorded now, so a run that pauses or fails before reaching them still reports them.
plan.tasks.filter(skipped).forEach(t => entries.push({ task: t.n, title: t.title, state: disposition(t), reason: t.reason || '' }))

const pre = await ruler(`Before Task 1 is dispatched, scan the plan above once for conflicts, writing down what you checked as you check it:
- tasks that contradict each other or the plan's Global Constraints
- anything the plan explicitly mandates that the review rubric treats as a defect (a test that asserts nothing, verbatim duplication of a logic block)

The scan's output is a table, not a verdict: one row for every pair of tasks that share a file or an interface (the two tasks, what one produces against what the other consumes, and what you found), and one row for every task (whether its own text agrees with itself: the tests it specifies against the code it specifies, the files it creates against the files it later touches). "The scan is clean" without those rows is not a scan you ran. Rule on every conflict the scan surfaces, against the plan text that mandates it.

Then choose each task's implementer model, using the least powerful model that can handle it: haiku for mechanical tasks (isolated functions, clear specs, 1-2 files, or the task's text contains the complete code), sonnet for integration and judgment tasks (multi-file coordination, pattern matching, debugging), opus for architecture and design tasks. Return only the rulings you made now.${RP ? `

This plan re-plans a branch an earlier run built part of. The rulings from before the re-plan (those starting "Before the re-plan:") hold unless the updated design contradicts them. List each one it contradicts in withdrawn, copied verbatim; it is no longer carried.` : ''}`,
  obj({ scan: arr(str), task_models: arr(obj({ task: int, model: { type: 'string', enum: TIERS } })), withdrawn: arr(str), ...RULINGS }, ['scan', 'task_models', 'rulings']),
  'pre-flight', 'Plan')
if (!pre) return result('failed', { stage: 'pre-flight' })
// Withdrawn rulings are removed in place (result() holds the same array), and only from those carried
// over, before this pre-flight's own rulings are added.
const withdrawn = (pre.withdrawn || []).filter(w => typeof w === 'string' && w.trim()).map(w => w.trim())
const CARRIED = 'Before the re-plan: '
const bare = x => (x.startsWith(CARRIED) ? x.slice(CARRIED.length) : x).trim()
const withdrawnBare = withdrawn.map(bare)
for (let i = rulings.length - 1; i >= 0; i--) if (rulings[i].startsWith(CARRIED) && withdrawnBare.includes(bare(rulings[i]))) rulings.splice(i, 1)
rule(...pre.rulings.map(x => `Pre-flight: ${x}`))
if (asks(pre)) return pause(pre.question, 'pre-flight')
const constraints = plan.global_constraints || '(none)'
const modelFor = n => (pre.task_models.find(t => t.task === n) || {}).model || 'sonnet'

// ---------- Tasks ----------
phase('Tasks')
// In re-plan mode building resumes from the branch's current commit; the final review still covers it all.
let lastHead = RP ? RP.head : A.base
for (const t of plan.tasks) {
  if (skipped(t)) continue
  const n = t.n, base = lastHead, entry = { task: n, title: t.title, state: 'done', rounds: 0, parked: 0 }
  current = { n, base, review: '', open: [] }
  let model = modelFor(n)
  const revising = disposition(t) === 'revised' || (demoted(t) && partlyBuilt(t)) ? `\n\nThis task was at least partly built in an earlier run and is being revised (${why(t)}): change what is on the branch rather than building it again.` : ''
  const context = `Task ${n} of ${plan.tasks.length}. The plan's overview:\n\n${plan.overview}${revising}`
  const applicable = () => rulings.slice()

  // 1-2. Dispatch the implementer and handle its status
  let impl, answer = ''
  for (let attempt = 1; ; attempt++) {
    impl = await ag(implementerPrompt({ n, title: t.title, text: t.text, context, constraints, applicable: applicable(), fix: answer ? `An earlier attempt at this task reported back, and the controller answered:\n${answer}` : '' }),
      { label: `implement-${n}${attempt > 1 ? `-a${attempt}` : ''}`, phase: 'Tasks', schema: IMPL, model, effort: effort(model) })
    if (!impl) return result('failed', { stage: `implement ${n}` })
    branchHead = impl.head_sha
    if (impl.status === 'DONE' || impl.status === 'DONE_WITH_CONCERNS') break
    if (attempt === 3) {
      const q = await ruler(`Task ${n}'s implementer (${model}) is still ${impl.status} after 3 dispatches, and there will be no further dispatch.\nIts summary: ${impl.summary}\nIts report:\n${impl.report}\nPut to the user the question that would let the task be built.`,
        obj({ ...RULINGS }, ['rulings', 'question']), `ask-${n}`, 'Tasks')
      if (!q) return result('failed', { stage: `ruling on task ${n}` })
      rule(...(q.rulings || []).map(x => `Task ${n}: ${x}`))
      return pause(asks(q) ? q.question : plainQuestion(`Task ${n} could not be built: the implementer is still ${impl.status} after 3 dispatches: ${impl.summary}`, 'the task stays unbuilt and the tasks after it may build on a guess'), `task ${n}`)
    }
    const r = await ruler(`Task ${n}'s implementer (${model}) reported ${impl.status}.\nIts summary: ${impl.summary}\nIts report:\n${impl.report}\nGive the missing context or your correction of the plan as answer, and set escalate if the task needs more reasoning than ${model} has.`,
      obj({ answer: str, escalate: bool, ...RULINGS }, ['answer', 'escalate', 'rulings']), `rule-${n}-a${attempt}`, 'Tasks')
    if (!r) return result('failed', { stage: `ruling on task ${n}` })
    rule(...r.rulings.map(x => `Task ${n}: ${x}`))
    if (asks(r)) return pause(r.question, `task ${n}`)
    if (r.escalate) model = up(model)
    answer = r.answer
  }
  let head = impl.head_sha
  const evidenceOnly = same(head, base)

  // 3. Review the task
  const reviewer = atLeast(model, 'sonnet')
  const review = await ag(taskReviewerPrompt({ n, title: t.title, text: t.text, constraints, revising, report: `${impl.report}\n\nFailing run before implementing (as reported):\n${impl.red}`, concerns: impl.status === 'DONE_WITH_CONCERNS' ? impl.summary : '', base, head, evidenceOnly }),
    { label: `review-${n}`, phase: 'Tasks', schema: REVIEW, model: reviewer, effort: effort(reviewer) })
  if (!review) return result('failed', { stage: `review ${n}` })
  entry.review = `${review.spec_verdict}, ${review.quality_verdict}`
  let open = review.findings.filter(f => f.severity !== 'Minor')
  current.review = entry.review; current.open = open; setOpen(`T${n}`, open)
  review.findings.filter(f => f.severity === 'Minor').forEach(f => deferred.push(`T${n} ${f.id}: ${f.text}${wrong(f)}`))

  // What the reviewer couldn't verify is checked against the code; findings the plan mandates are ruled on
  if (review.cannot_verify.length) {
    const c = await ag(`Task ${n} of a plan, commits ${base}..${head} on this branch. The task:\n\n${t.text}\n\nThe task reviewer could not verify these requirements from the diff alone. Check each in the code, read only, and return each one that is a real gap, with file:line evidence; leave out the ones the code satisfies.\n${review.cannot_verify.join('\n')}`,
      { label: `verify-${n}`, phase: 'Tasks', model: 'sonnet', effort: 'medium', schema: obj({ gaps: arr(str) }) })
    if (!c) return result('failed', { stage: `verify ${n}` })
    open = open.concat(c.gaps.map((g, i) => ({ id: `T${n}-G${i + 1}`, severity: 'Important', text: g })))
    current.open = open; setOpen(`T${n}`, open)
  }
  const mandated = open.filter(f => f.plan_mandated)
  if (mandated.length) {
    const r = await ruler(`Task ${n} (commits ${base}..${head}). Rule on each plan-mandated finding against the plan text that mandates it; return in keep the ids that should go to the fix loop.\n${fmt(mandated)}`,
      obj({ keep: arr(str), ...RULINGS }, ['keep', 'rulings']), `resolve-${n}`, 'Tasks')
    if (!r) return result('failed', { stage: `resolve ${n}` })
    rule(...r.rulings.map(x => `Task ${n}: ${x}`))
    if (asks(r)) return pause(r.question, `task ${n}`)
    open = open.filter(f => !f.plan_mandated || r.keep.includes(f.id))
    current.open = open; setOpen(`T${n}`, open)
  }

  // 4. The fix loop
  const loop = await fixLoop({
    open, head, model, label: `task-${n}`, phase: 'Tasks', idPrefix: `T${n}-`,
    task: `Task ${n}: ${t.title}\n\n${t.text}`,
    fixPrompt: (round, reports, items) => implementerPrompt({
      n, title: t.title, text: t.text, context, constraints, applicable: applicable(),
      fix: `${round <= 3 ? `Fix round ${round} of ${CAP}: this task has been implemented; here is the original report${reports.length ? ' and the earlier fix reports' : ''}.` : `A prior implementer attempted this task ${round - 1} times; you own it now. Here is what was tried.`}

Original report:
${impl.report}
${reports.length ? `\n${reports.join('\n\n')}\n` : ''}
Fix these findings, re-run the tests that cover the amended code, and commit. Your report is the fix report: what you changed per finding, the covering tests, the command and the output. If a finding can't be fixed without changing the design, don't work around it: return BLOCKED and say in your report which design decision it needs.
${fmt(items)}`,
    }),
    onDeferred: x => deferred.push(`T${n} ${x}`),
    onRound: round => { entry.rounds = round },
    track: o => { current.open = o; setOpen(`T${n}`, o) },
  })
  if (loop.failed) return result('failed', { stage: loop.failed })
  head = loop.head || head
  open = loop.open

  // The breaker
  if (open.length) {
    const r = await breaker(`Task ${n}'s fix loop hit its cap of ${CAP} rounds (commits ${base}..${head}).`, open, 'carry', `breaker-${n}`, 'Tasks')
    if (!r) return result('failed', { stage: `breaker ${n}` })
    rule(...r.rulings.map(x => `Task ${n}: ${x}`))
    if (asks(r)) return pause(r.question, `task ${n}`)
    setOpen()
    for (const d of r.decisions) {
      const f = open.find(x => x.id === d.id) || { id: d.id, text: '' }
      if (d.decision === 'park') { rule(`Task ${n}: parked: ${f.id} ${f.text}; ruling: ${d.ruling}`); parked.push(`T${n} ${f.id}: ${f.text}; ruling: ${d.ruling}`) }
      else { rule(`Task ${n}: ${d.ruling}`); carry.push(`Task ${n}: ${d.ruling}`) }
    }
    entry.parked = open.length
  }
  entry.commits = same(head, base) ? 'none, evidence reviewed' : `${base.slice(0, 7)}..${head.slice(0, 7)}`
  entry.tests = impl.summary
  lastHead = head
  entries.push(entry)
  current = null; setOpen()
  log(`Task ${n}: ${entry.rounds} fix round(s), ${entry.parked} parked`)
}

// ---------- Final review ----------
phase('Final review')
const final = await ag(branchReviewerPrompt({ planText, base: A.base, head: lastHead, triage: [...deferred, ...parked].map(x => `- ${x}`).join('\n') }),
  { label: 'final-review', phase: 'Final review', model: 'opus', effort: 'xhigh', schema: obj({ summary: str, declined: arr(str), ready: { type: 'string', enum: ['Yes', 'No', 'With fixes'] }, findings: arr(obj({ id: str, severity: SEV, must_fix: bool, text: str }, ['id', 'severity', 'text'])) }) })
if (!final) return result('failed', { stage: 'final review' })
declined.push(...(final.declined || []))
let finalOpen = final.findings.filter(f => f.severity !== 'Minor' || f.must_fix)
final.findings.filter(f => f.severity === 'Minor' && !f.must_fix).forEach(f => deferred.push(`final ${f.id}: ${f.text}`))
setOpen('final', finalOpen)
let finalFix = ''
if (finalOpen.length) {
  const fixBase = lastHead
  const fix = await ag(`Fix these findings from the whole-branch review of this branch in one pass. Re-run the tests that cover what you change, and commit. ${LOCAL} ${NO_SUB}

## The Design

${A.design}

## Rulings Made in This Run

${rulings.join('\n') || '(none)'}

## The Findings

${fmt(finalOpen)}

Return in report what changed per finding, the covering tests, the command and the output. head_sha is the full commit id from \`git rev-parse HEAD\` when you finish.`,
    { label: 'final-fix', phase: 'Final review', schema: IMPL, model: 'sonnet', effort: 'medium' })
  if (!fix) return result('failed', { stage: 'final fix' })
  lastHead = branchHead = fix.head_sha
  finalFix = fix.report
  const rr = await ag(reReviewPrompt({ task: 'The whole branch, reviewed against the design and plan.', findings: fmt(finalOpen), reports: fix.report, fixBase, head: fix.head_sha, idPrefix: 'F-R-' }),
    { label: 'final-re-review', phase: 'Final review', schema: REREVIEW, model: 'sonnet', effort: 'medium' })
  if (!rr) return result('failed', { stage: 'final re-review' })
  const addressed = closed(rr)
  rr.new_findings.filter(f => f.severity === 'Minor').map(f => `${f.id} ${f.text}`).concat(rr.out_of_scope).forEach(x => deferred.push(`final ${x}`))
  finalOpen = finalOpen.filter(f => !addressed.has(f.id)).concat(rr.new_findings.filter(f => f.severity !== 'Minor'))
  setOpen('final', finalOpen)
  if (finalOpen.length) {
    const r = await breaker(`The final whole-branch review's single fix wave left these findings open. There is no second wave.`, finalOpen, 'surface', 'final-breaker', 'Final review')
    if (!r) return result('failed', { stage: 'final breaker' })
    rule(...r.rulings.map(x => `Final: ${x}`))
    if (asks(r)) return pause(r.question, 'final')
    setOpen()
    for (const d of r.decisions) {
      const f = finalOpen.find(x => x.id === d.id) || { id: d.id, text: '' }
      if (d.decision === 'park') { rule(`Final: parked: ${f.id} ${f.text}; ruling: ${d.ruling}`); parked.push(`final ${f.id}: ${f.text}; ruling: ${d.ruling}`) }
      else { rule(`Final: ${d.ruling}`); surfaced.push(`${f.id}: ${f.text}; ruling: ${d.ruling}`) }
    }
  }
}

const dc = await deferralCheck(lastHead, 'Final review')
if (dc.failed) return result('failed', { stage: dc.failed })
if (dc.question) { parkSurfaced(); return pause(dc.question, 'deferral check') }
lastHead = dc.head
if (dc.fixed) finalFix = `${finalFix}\n\nFixed after the deferral check:\n${dc.fixed}`

// ---------- Write-up: the PR description, from the design and the run's results only ----------
phase('Write-up')
const w = await ag(`Write the pull request description for this branch, for a reviewer who knows only the code and this description. Read the commits with \`git log ${A.base}..HEAD\` and the change with \`git diff --stat ${A.base}..HEAD\` as needed; change nothing.

## The Template

${A.pr_template}

## The Design

${A.design}

## The Plan's Overview

${plan.overview}

Assumptions:
${plan.assumptions.map(x => `- ${x}`).join('\n') || '(none)'}

Follow-ups:
${plan.follow_ups.map(x => `- ${x}`).join('\n') || '(none)'}

## The Run
${RP && RP.decision ? `\nRe-planned after: ${RP.decision}\n` : ''}
Tasks:
${outcomes().map(e => e.state === 'kept' ? `- Task ${e.task}: ${e.title}. Kept from the earlier run: ${e.reason}`
    : e.state === 'dropped' ? `- Task ${e.task}: ${e.title}. Dropped: ${e.reason}`
      : `- Task ${e.task}: ${e.title}. Commits ${e.commits}; review ${e.review}; ${e.rounds} fix round(s); ${e.parked} parked. Tests: ${e.tests}`).join('\n')}

Rulings:
${rulings.join('\n') || '(none)'}

Parked findings:
${parked.join('\n') || '(none)'}

Deferred minor findings:
${deferred.join('\n') || '(none)'}

Final review: ${final.summary}

Set aside by the final review as outside the plan, after the deferral check (for a human to judge):
${declined.join('\n') || '(none)'}
${finalFix ? `\nFinal fix:\n${finalFix}\n` : ''}
Surfaced for a human:
${surfaced.join('\n') || '(none)'}

Fill in the template, writing for a reviewer's time:
- Aim for about 300 words. Leave out any section that would be empty; never write "None".
- Under decisions, only those a reviewer could reasonably disagree with, and any you're unsure about: five at most. The other rulings stay out.
- Under what's not done, only what a reviewer would expect to find in this change. Leave trivia out.
- No paragraph longer than about three sentences: where there are several separate things, introduce them with a sentence and list them, one line each.
- Don't describe the diff, which the reviewer can read, and don't tell the reviewer where to look or what to skip.
- It must stand on its own: state each decision in its own terms.
Don't add a footer or a note about how this was made; one is added for you. Return the title and the body.`,
  { label: 'write-up', phase: 'Write-up', model: 'sonnet', effort: 'medium', schema: obj({ title: str, body: str }) })
if (!w) return result('failed', { stage: 'write-up' })

return result('done', { final_head: lastHead, scan: pre.scan, assumptions: plan.assumptions, follow_ups: plan.follow_ups, final_review: final.summary, surfaced, pr_title: w.title, pr_body: withFooter(w.body) })
}
try { return await main() } catch (e) { return result('failed', { stage: lastLabel, error: String((e && e.message) || e) }) }
