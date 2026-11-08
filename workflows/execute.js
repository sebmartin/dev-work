export const meta = {
  name: 'execute',
  description: 'dev-work: plan a design and build it the way superpowers:subagent-driven-development does, with this script as its controller',
  whenToUse: 'Started by the dev-work develop skill.',
  phases: [{ title: 'Plan' }, { title: 'Tasks' }, { title: 'Final review' }, { title: 'Write-up' }, { title: 'Review feedback' }],
}

// args: { design, inputs, pr_template, base, feedback?, round?, pr?, head? }
//   design       the design's text, verbatim
//   inputs       [{ name, description }] for files the session staged in .dev-work/inputs/
//   pr_template  the PR template's text
//   base         the commit the branch starts from (40 hex)
//   feedback     for a review round: [{ id, text }] from the PR's review and the user
//   round, pr    the round number and the PR's current description
//   head         for a review round: the branch's commit id before the round
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
const ag = (prompt, opts = {}) => agent(prompt, { agentType: 'dev-work:worker', ...opts })
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
const FINDING = obj({ id: str, severity: SEV, text: str, plan_mandated: bool }, ['id', 'severity', 'text'])
const PLAN = obj({ overview: str, global_constraints: str, review_focus: str, assumptions: arr(str), follow_ups: arr(str), tasks: arr(obj({ n: int, title: str, text: str })) })
const IMPL = obj({
  status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'] },
  head_sha: SHA,
  summary: { type: 'string', description: 'under 15 lines: commits (short id and subject), a one-line test summary, concerns' },
  report: { type: 'string', description: 'the full report described under Report Format' },
}, ['status', 'head_sha', 'summary', 'report'])
const REVIEW = obj({ spec_verdict: { type: 'string', enum: ['pass', 'fail'] }, cannot_verify: arr(str), quality_verdict: { type: 'string', enum: ['Approved', 'Needs fixes'] }, findings: arr(FINDING) })
const REREVIEW = obj({ results: arr(obj({ id: str, addressed: bool, evidence: { type: 'string', description: 'file:line showing the fix, or the evidence that it should not change' } })), new_findings: arr(FINDING), out_of_scope: arr(str) })
// A finding counts as addressed only with evidence: a bare "addressed" from a quick look doesn't close it.
const closed = rr => new Set(rr.results.filter(r => r.addressed && (r.evidence || '').trim()).map(r => r.id))
const RULINGS = { rulings: arr(str), stop: bool, stop_reason: str }

const LOCAL = 'Work only in this checkout, your current directory: commit on the current branch, never push or touch a remote. Add every change as a new commit: never amend, rebase, reset or otherwise rewrite commits, and never force-add ignored files (no `git add -f`). Put any scratch files in .dev-work/scratch/ in this checkout, never anywhere else. Write commit messages for a stranger: what changed and why, in their own terms.'
const NO_SUB = 'Do all of this yourself. Never spawn a subagent to do part of it, and above all never spawn a reviewer to check your work.'
const INPUTS = (A.inputs || []).length ? `\nInput files the design names are in .dev-work/inputs/:\n${A.inputs.map(i => `- .dev-work/inputs/${i.name}: ${i.description}`).join('\n')}` : ''
const fmt = fs => fs.map(f => `- ${f.id} (${f.severity}): ${f.text}`).join('\n')
const same = (a, b) => !!a && !!b && a === b

const rulings = [], parked = [], deferred = [], carry = []
const rule = (...lines) => rulings.push(...lines)
const result = (status, extra = {}) => ({ status, ...extra, rulings, parked, deferred, carried: carry })

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

How to escalate: return status BLOCKED or NEEDS_CONTEXT, and say in the report specifically what you're stuck on, what you've tried, and what kind of help you need.

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

Return in summary, under 15 lines: the commits created (short id and subject), a one-line test summary, and your concerns. head_sha is the full commit id from \`git rev-parse HEAD\` when you finish.

Use DONE_WITH_CONCERNS if you completed the work but have doubts about correctness. Use BLOCKED if you cannot complete the task. Use NEEDS_CONTEXT if you need information that wasn't provided. Never silently produce work you're unsure about.`

const diffCommands = (from, to) => `\`git log --oneline ${from}..${to}\`, \`git diff --stat ${from}..${to}\` and \`git diff ${from}..${to}\``

const taskReviewerPrompt = ({ n, title, text, constraints, report, concerns, base, head, evidenceOnly }) => `You are reviewing one task's implementation: first whether it matches its requirements, then whether it is well-built. This is a task-scoped gate, not a merge review; a broad whole-branch review happens separately after all tasks are complete.

## What Was Requested

Task ${n}: ${title}

${text}

Global constraints from the design and plan that bind this task:
${constraints}

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

Categorize issues by actual severity. Not everything is Critical. Important means this task cannot be trusted until it is fixed: incorrect or fragile behavior, a missed requirement, or maintainability damage you would block a merge over (verbatim duplication of a logic block, swallowed errors, tests that assert nothing). "Coverage could be broader" and polish suggestions are Minor. If the plan or task explicitly mandates something this rubric calls a defect, that is a finding: report it as Important with plan_mandated set. Acknowledge what was done well before listing issues; accurate praise helps the implementer trust the rest.

## Output

spec_verdict: pass or fail. cannot_verify: the requirements you couldn't verify from the diff alone, each saying what should be checked. quality_verdict: Approved or Needs fixes. findings: each with an id T${n}-1, T${n}-2 and so on, its severity, and the text: file:line, what's wrong, why it matters, how to fix it if not obvious.`

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

results: each finding's id, addressed true or false, and evidence: the file:line that shows it fixed, or the report's evidence that it should not change. A finding with no evidence stays open. new_findings: anything the fix itself broke or introduced, with severity and file:line, ids ${idPrefix}1, ${idPrefix}2 and so on. out_of_scope: issues entirely outside the fix diff.`

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

## Declined to Judge

Before your verdict, list every behavior you considered and set aside as outside the plan or design, one line each, with the reason. Nothing you set aside is dropped silently: each line goes to a human. An empty list means you set nothing aside.

## Earlier Findings to Triage

These were deferred as Minor or parked during the task reviews. Set must_fix on any that must be fixed before merge, as a Minor finding if it isn't already one:
${triage || '(none)'}

## Calibration

Categorize issues by actual severity: Critical (bugs, security issues, data loss risks, broken functionality), Important (architecture problems, missing features, poor error handling, test gaps), Minor (style, optimization, documentation polish). Not everything is Critical. Be specific (file:line), explain why each issue matters, and give a clear verdict.

## Output

summary: your assessment and its reasoning, including what's done well, and your recommendations. declined: the Declined to Judge lines. ready: Yes, No or With fixes. findings: ids F-1, F-2 and so on, each with severity, must_fix where it applies, and the text: file:line, what's wrong, why it matters, how to fix it.`

// The ruler makes the calls Superpowers leaves to its controller.
let planText = ''
const ruler = (question, schema, label, phase) => ag(`You make the judgment calls a person would make while a plan is built task by task by implementer and reviewer agents, for the run building the design below. The design is the binding authority, the plan is its argument, and your judgment settles what neither answers. Read the code as needed; don't change it.

## The Design

${A.design}
${planText ? `\n## The Plan\n\n${planText}\n` : ''}
## Rulings so far

${rulings.join('\n') || '(none)'}

## The Question

${question}

Write every decision as "Ruling: <what you decided>; why: <why>; cost if wrong: <what it costs if wrong>". Decide; nobody will answer questions. Set stop only for an irreversible or destructive operation, a security-sensitive action, or a plan so broken that every path forward is a guess, and say why in stop_reason.`,
  { label, phase, schema, model: 'opus', effort: 'high' })

// A stop says what kind it is, so the session doesn't have to guess from the text: 'design' needs a
// decision about the design from the user, 'ruler' is the ruler stopping on a risk or a broken plan,
// 'blocked' is an implementer that couldn't finish.
const stop = (reason, at, kind = 'ruler') => result('stopped', { at, reason, kind })

// Fix rounds on a set of findings: a fresh implementer per round (rounds 1-3 on the given model, 4-5 one
// tier up), each followed by a scoped re-review. Returns the findings still open and the new head.
const fixLoop = async ({ open, head, model, label, phase, fixPrompt, task, idPrefix, onDeferred, onRound }) => {
  const reports = []
  for (let round = 1; open.length && round <= CAP; round++) {
    const fixBase = head, fixModel = round <= 3 ? model : up(model)
    const fix = await ag(fixPrompt(round, reports, open), { label: `${label}-fix-r${round}`, phase, schema: IMPL, model: fixModel, effort: effort(fixModel) })
    if (!fix) return { open, head, failed: `${label} fix round ${round}` }
    head = fix.head_sha
    reports.push(`Fix round ${round}:\n${fix.report}`)
    const rr = await ag(reReviewPrompt({ task, findings: fmt(open), reports: reports.join('\n\n'), fixBase, head, idPrefix: `${idPrefix}R${round}-` }),
      { label: `${label}-re-review-r${round}`, phase, schema: REREVIEW, model: 'sonnet', effort: 'medium' })
    if (!rr) return { open, head, failed: `${label} re-review round ${round}` }
    // A finding counts as addressed only if the re-review says so: one it skips stays open.
    const addressed = closed(rr)
    rr.new_findings.filter(f => f.severity === 'Minor').map(f => `${f.id} ${f.text}`).concat(rr.out_of_scope).forEach(onDeferred)
    const before = open.length
    open = open.filter(f => !addressed.has(f.id)).concat(rr.new_findings.filter(f => f.severity !== 'Minor'))
    onRound(round, before - (open.length - rr.new_findings.filter(f => f.severity !== 'Minor').length), open.length, fixBase, head)
    // A fix agent that couldn't proceed ends the loop; the breaker rules on what's left.
    if (fix.status === 'BLOCKED' || fix.status === 'NEEDS_CONTEXT') { open = open.map(f => ({ ...f, text: `${f.text} (the fix agent reported ${fix.status}: ${fix.summary})` })); break }
  }
  return { open, head }
}

// The breaker: adjudicate findings still open after the cap.
const breaker = async (context, open, choices, label, phase) => {
  const r = await ruler(`${context} Adjudicate each open finding: park it (the reviewer is wrong or the point is contestable, or it is real but nothing downstream builds on it), or ${choices === 'carry' ? 'if it is real and load-bearing, rule on the smallest change that unblocks the dependent work; that ruling is carried into later tasks' : 'if it is real and load-bearing, rule on it; those are surfaced to the user'}.
${fmt(open)}`,
    obj({ decisions: arr(obj({ id: str, decision: { type: 'string', enum: ['park', choices] }, ruling: str })), ...RULINGS }, ['decisions', 'rulings', 'stop']), label, phase)
  if (r) {
    const decided = new Set(r.decisions.map(d => d.id))
    open.filter(f => !decided.has(f.id)).forEach(f => r.decisions.push({ id: f.id, decision: choices === 'carry' ? 'carry' : 'surface', ruling: 'No ruling was returned for this finding; it stays open.' }))
  }
  return r
}

// ---------- The deferral check ----------
// Everything headed for "not fixed" gets an independent look before anything is published: the reviewer
// that labelled a finding and the session that wants to finish both have a stake in deferring it.
const DEFERRAL = obj({ items: arr(obj({ id: str, consequence: str, verdict: { type: 'string', enum: ['resolve', 'defer', 'fixed'] }, needs_design_change: bool, reason: str })) })
const deferralCheck = async (head, phaseName) => {
  const items = [...deferred.map(x => ({ from: 'deferred', text: x })), ...parked.map(x => ({ from: 'parked', text: x }))].map((x, i) => ({ id: `D-${i + 1}`, ...x }))
  if (!items.length) return { head }
  const c = await ag(`Findings from this run are about to be left out of the pull request: deferred as minor, filed as out of scope, or parked. Each was set aside by whoever found it, and nobody has checked that call. Check it.

## The Design

${A.design}

## The Findings

${items.map(i => `- ${i.id} (${i.from}): ${i.text}`).join('\n')}

For each finding, read the code it points at and work out what actually goes wrong, and for whom, if this branch ships as it is: a person or an agent using the software, not the code's tidiness. Write that in consequence, concretely, or "nothing goes wrong" with why. Then:
- verdict resolve when something real goes wrong: content lost or silently overwritten, the software not doing what the design says, or an agent steered into doing the wrong thing. Set needs_design_change when fixing it would contradict or go beyond the design.
- verdict defer when nothing concrete goes wrong, and say why in reason.
- verdict fixed when the branch has already fixed it (a later fix may have), with the evidence in reason.
Read only.`,
    { label: `deferral-check`, phase: phaseName, model: 'opus', effort: 'high', schema: DEFERRAL })
  if (!c) return { head, failed: 'deferral check' }
  const byId = Object.fromEntries(items.map(i => [i.id, i.text])), fromId = Object.fromEntries(items.map(i => [i.id, i.from]))
  const decided = new Set(c.items.map(x => x.id))
  // A finding the check skipped is treated as needing resolution: it fails closed.
  items.filter(i => !decided.has(i.id)).forEach(i => c.items.push({ id: i.id, consequence: 'not assessed', verdict: 'resolve', needs_design_change: false, reason: 'the check returned no verdict' }))
  const design = c.items.filter(x => x.verdict === 'resolve' && x.needs_design_change)
  if (design.length) return { head, stop: `These findings would cause real harm if shipped, and fixing them needs a design decision:\n${design.map(x => `- ${byId[x.id]}\n  What goes wrong: ${x.consequence}`).join('\n')}` }
  const fixList = c.items.filter(x => x.verdict === 'resolve').map(x => ({ id: x.id, severity: 'Important', text: `${byId[x.id]} What goes wrong if shipped: ${x.consequence}` }))
  deferred.length = 0; parked.length = 0
  c.items.filter(x => x.verdict === 'defer').forEach(x => (fromId[x.id] === 'parked' ? parked : deferred).push(`${byId[x.id]} (left out because: ${x.reason})`))
  if (!fixList.length) return { head }
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
  const rr = await ag(reReviewPrompt({ task: 'Findings that were going to be left out of the pull request, fixed because they cause real harm.', findings: fmt(fixList), reports: fix.report, fixBase: head, head: fix.head_sha, idPrefix: 'D-R-' }),
    { label: 'deferral-re-review', phase: phaseName, schema: REREVIEW, model: 'sonnet', effort: 'medium' })
  if (!rr) return { head: fix.head_sha, failed: 'deferral re-review' }
  const addressed = closed(rr)
  const left = fixList.filter(f => !addressed.has(f.id)).concat(rr.new_findings.filter(f => f.severity !== 'Minor'))
  if (left.length) return { head: fix.head_sha, stop: `These findings cause real harm and are still open after a fix:\n${fmt(left)}` }
  rr.new_findings.filter(f => f.severity === 'Minor').map(f => `${f.id} ${f.text}`).concat(rr.out_of_scope).forEach(x => deferred.push(`${x} (found after the deferral check, not assessed)`))
  return { head: fix.head_sha, fixed: fix.report }
}

// ---------- Review feedback: fix rounds on a review of the PR, then the replies ----------
if (A.feedback) {
  phase('Review feedback')
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
  })
  if (loop.failed) return result('failed', { stage: loop.failed })
  A.feedback.forEach((f, i) => { const id = f.id || `PR${R}-${i + 1}`; if (!loop.open.find(o => o.id === id)) outcome[id] = 'addressed' })
  const surfaced = []
  if (loop.open.length) {
    const r = await breaker(`Review round ${R} on the pull request hit its cap of ${CAP} fix rounds.`, loop.open, 'surface', 'round-breaker', 'Review feedback')
    if (!r) return result('failed', { stage: 'round breaker' })
    if (r.stop) return stop(r.stop_reason, `round ${R}`)
    for (const d of r.decisions) {
      const f = loop.open.find(x => x.id === d.id) || { id: d.id, text: '' }
      outcome[d.id] = `${d.decision}: ${d.ruling}`
      if (d.decision === 'park') { rule(`Round ${R}: parked: ${f.id} ${f.text}; ruling: ${d.ruling}`); parked.push(`round ${R} ${f.id}: ${f.text}; ruling: ${d.ruling}`) }
      else { rule(`Round ${R}: ${d.ruling}`); surfaced.push(`${f.id}: ${f.text}; ruling: ${d.ruling}`) }
    }
    rule(...r.rulings.map(x => `Round ${R}: ${x}`))
  }
  const dc = await deferralCheck(loop.head, 'Review feedback')
  if (dc.failed) return result('failed', { stage: dc.failed })
  if (dc.stop) return stop(dc.stop, `round ${R} deferral check`, 'design')
  loop.head = dc.head
  phase('Write-up')
  const w = await ag(`Write the replies to a review of a pull request, for a reader who knows only the pull request. Read what the round changed with \`git log\` and \`git diff\` on this branch as needed; change nothing.

## The Pull Request's Description

${A.pr || '(none)'}

## The Feedback and What Happened

${A.feedback.map((f, i) => { const id = f.id || `PR${R}-${i + 1}`; return `- ${id}: ${f.text}\n  Outcome: ${outcome[id] || 'open'}` }).join('\n')}

## The Round's Rulings

${rulings.filter(x => x.startsWith(`Round ${R}`)).join('\n') || '(none)'}

For each item, write a short reply saying what was done, or why it wasn't, standing on its own. If the round changed anything the description says, return the whole updated description in pr_body; otherwise return pr_body empty.`,
    { label: `round-${R}-write-up`, phase: 'Write-up', model: 'sonnet', effort: 'medium', schema: obj({ replies: arr(obj({ id: str, reply: str })), pr_body: str }) })
  if (!w) return result('failed', { stage: 'round write-up' })
  return result('done', { final_head: loop.head, round: R, outcome, surfaced, replies: w.replies, pr_body: w.pr_body })
}

// ---------- Plan ----------
phase('Plan')
const plan = await ag(`Write the implementation plan for the design below, for an engineer who has not seen this codebase or this design. Assume they write idiomatic code in the project's language once they know the exact interface and the exact test, and that they will make a reasonable choice wherever the plan leaves one open. What they cannot know is what you decided: which files, which names and signatures, which values from the design, which tests prove each task. Document those. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

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

## Return

Don't save the plan to a file: return it, as below.

- overview: everything in the plan before the first task (title, Goal, Architecture, Tech Stack, Global Constraints, Review Focus, file structure).
- global_constraints and review_focus: those two sections' text.
- assumptions and follow_ups: one entry each.
- tasks: in order, each with its number, its title and its full text, exactly as the plan has it.`,
  { label: 'plan', phase: 'Plan', model: 'opus', effort: 'medium', schema: PLAN })
if (!plan) return result('failed', { stage: 'plan' })
planText = `${plan.overview}\n\n${plan.tasks.map(t => `### Task ${t.n}: ${t.title}\n\n${t.text}`).join('\n\n')}`

const pre = await ruler(`Before Task 1 is dispatched, scan the plan above once for conflicts, writing down what you checked as you check it:
- tasks that contradict each other or the plan's Global Constraints
- anything the plan explicitly mandates that the review rubric treats as a defect (a test that asserts nothing, verbatim duplication of a logic block)

The scan's output is a table, not a verdict: one row for every pair of tasks that share a file or an interface (the two tasks, what one produces against what the other consumes, and what you found), and one row for every task (whether its own text agrees with itself: the tests it specifies against the code it specifies, the files it creates against the files it later touches). "The scan is clean" without those rows is not a scan you ran. Rule on every conflict the scan surfaces, against the plan text that mandates it.

Then choose each task's implementer model, using the least powerful model that can handle it: haiku for mechanical tasks (isolated functions, clear specs, 1-2 files, or the task's text contains the complete code), sonnet for integration and judgment tasks (multi-file coordination, pattern matching, debugging), opus for architecture and design tasks. Return only the rulings you made now.`,
  obj({ scan: arr(str), task_models: arr(obj({ task: int, model: { type: 'string', enum: TIERS } })), ...RULINGS }, ['scan', 'task_models', 'rulings', 'stop']),
  'pre-flight', 'Plan')
if (!pre) return result('failed', { stage: 'pre-flight' })
rule(...pre.rulings.map(x => `Pre-flight: ${x}`))
if (pre.stop) return stop(pre.stop_reason, 'pre-flight')
const constraints = plan.global_constraints || '(none)'
const modelFor = n => (pre.task_models.find(t => t.task === n) || {}).model || 'sonnet'

// ---------- Tasks ----------
phase('Tasks')
let lastHead = A.base
const tasks = []
for (const t of plan.tasks) {
  const n = t.n, base = lastHead, entry = { task: n, title: t.title, rounds: 0, parked: 0 }
  let model = modelFor(n)
  const context = `Task ${n} of ${plan.tasks.length}. The plan's overview:\n\n${plan.overview}`
  const applicable = () => rulings.slice()

  // 1-2. Dispatch the implementer and handle its status
  let impl, answer = ''
  for (let attempt = 1; ; attempt++) {
    impl = await ag(implementerPrompt({ n, title: t.title, text: t.text, context, constraints, applicable: applicable(), fix: answer ? `An earlier attempt at this task reported back, and the controller answered:\n${answer}` : '' }),
      { label: `implement-${n}${attempt > 1 ? `-a${attempt}` : ''}`, phase: 'Tasks', schema: IMPL, model, effort: effort(model) })
    if (!impl) return result('failed', { stage: `implement ${n}` })
    if (impl.status === 'DONE' || impl.status === 'DONE_WITH_CONCERNS') break
    if (attempt === 3) return stop(`task ${n}'s implementer still ${impl.status} after 3 dispatches: ${impl.summary}`, `task ${n}`, 'blocked')
    const r = await ruler(`Task ${n}'s implementer (${model}) reported ${impl.status}.\nIts summary: ${impl.summary}\nIts report:\n${impl.report}\nGive the missing context or your correction of the plan as answer, and set escalate if the task needs more reasoning than ${model} has.`,
      obj({ answer: str, escalate: bool, ...RULINGS }, ['answer', 'escalate', 'rulings', 'stop']), `rule-${n}-a${attempt}`, 'Tasks')
    if (!r) return result('failed', { stage: `ruling on task ${n}` })
    if (r.stop) return stop(r.stop_reason, `task ${n}`)
    rule(...r.rulings.map(x => `Task ${n}: ${x}`))
    if (r.escalate) model = up(model)
    answer = r.answer
  }
  let head = impl.head_sha
  const evidenceOnly = same(head, base)

  // 3. Review the task
  const reviewer = atLeast(model, 'sonnet')
  const review = await ag(taskReviewerPrompt({ n, title: t.title, text: t.text, constraints, report: impl.report, concerns: impl.status === 'DONE_WITH_CONCERNS' ? impl.summary : '', base, head, evidenceOnly }),
    { label: `review-${n}`, phase: 'Tasks', schema: REVIEW, model: reviewer, effort: effort(reviewer) })
  if (!review) return result('failed', { stage: `review ${n}` })
  entry.review = `${review.spec_verdict}, ${review.quality_verdict}`
  let open = review.findings.filter(f => f.severity !== 'Minor')
  review.findings.filter(f => f.severity === 'Minor').forEach(f => deferred.push(`T${n} ${f.id}: ${f.text}`))

  // What the reviewer couldn't verify is checked against the code; findings the plan mandates are ruled on
  if (review.cannot_verify.length) {
    const c = await ag(`Task ${n} of a plan, commits ${base}..${head} on this branch. The task:\n\n${t.text}\n\nThe task reviewer could not verify these requirements from the diff alone. Check each in the code, read only, and return each one that is a real gap, with file:line evidence; leave out the ones the code satisfies.\n${review.cannot_verify.join('\n')}`,
      { label: `verify-${n}`, phase: 'Tasks', model: 'sonnet', effort: 'medium', schema: obj({ gaps: arr(str) }) })
    if (!c) return result('failed', { stage: `verify ${n}` })
    open = open.concat(c.gaps.map((g, i) => ({ id: `T${n}-G${i + 1}`, severity: 'Important', text: g })))
  }
  const mandated = open.filter(f => f.plan_mandated)
  if (mandated.length) {
    const r = await ruler(`Task ${n} (commits ${base}..${head}). Rule on each plan-mandated finding against the plan text that mandates it; return in keep the ids that should go to the fix loop.\n${fmt(mandated)}`,
      obj({ keep: arr(str), ...RULINGS }, ['keep', 'rulings', 'stop']), `resolve-${n}`, 'Tasks')
    if (!r) return result('failed', { stage: `resolve ${n}` })
    if (r.stop) return stop(r.stop_reason, `task ${n}`)
    rule(...r.rulings.map(x => `Task ${n}: ${x}`))
    open = open.filter(f => !f.plan_mandated || r.keep.includes(f.id))
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
Fix these findings, re-run the tests that cover the amended code, and commit. Your report is the fix report: what you changed per finding, the covering tests, the command and the output.
${fmt(items)}`,
    }),
    onDeferred: x => deferred.push(`T${n} ${x}`),
    onRound: round => { entry.rounds = round },
  })
  if (loop.failed) return result('failed', { stage: loop.failed })
  head = loop.head || head
  open = loop.open

  // The breaker
  if (open.length) {
    const r = await breaker(`Task ${n}'s fix loop hit its cap of ${CAP} rounds (commits ${base}..${head}).`, open, 'carry', `breaker-${n}`, 'Tasks')
    if (!r) return result('failed', { stage: `breaker ${n}` })
    if (r.stop) return stop(r.stop_reason, `task ${n}`)
    for (const d of r.decisions) {
      const f = open.find(x => x.id === d.id) || { id: d.id, text: '' }
      if (d.decision === 'park') { rule(`Task ${n}: parked: ${f.id} ${f.text}; ruling: ${d.ruling}`); parked.push(`T${n} ${f.id}: ${f.text}; ruling: ${d.ruling}`) }
      else { rule(`Task ${n}: ${d.ruling}`); carry.push(`Task ${n}: ${d.ruling}`) }
    }
    rule(...r.rulings.map(x => `Task ${n}: ${x}`))
    entry.parked = open.length
  }
  entry.commits = same(head, base) ? 'none, evidence reviewed' : `${base.slice(0, 7)}..${head.slice(0, 7)}`
  entry.tests = impl.summary
  lastHead = head
  tasks.push(entry)
  log(`Task ${n}: ${entry.rounds} fix round(s), ${entry.parked} parked`)
}

// ---------- Final review ----------
phase('Final review')
const final = await ag(branchReviewerPrompt({ planText, base: A.base, head: lastHead, triage: [...deferred, ...parked].map(x => `- ${x}`).join('\n') }),
  { label: 'final-review', phase: 'Final review', model: 'opus', effort: 'high', schema: obj({ summary: str, declined: arr(str), ready: { type: 'string', enum: ['Yes', 'No', 'With fixes'] }, findings: arr(obj({ id: str, severity: SEV, must_fix: bool, text: str }, ['id', 'severity', 'text'])) }) })
if (!final) return result('failed', { stage: 'final review' })
let finalOpen = final.findings.filter(f => f.severity !== 'Minor' || f.must_fix)
final.findings.filter(f => f.severity === 'Minor' && !f.must_fix).forEach(f => deferred.push(`final ${f.id}: ${f.text}`))
const surfaced = []
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
  lastHead = fix.head_sha
  finalFix = fix.report
  const rr = await ag(reReviewPrompt({ task: 'The whole branch, reviewed against the design and plan.', findings: fmt(finalOpen), reports: fix.report, fixBase, head: fix.head_sha, idPrefix: 'F-R-' }),
    { label: 'final-re-review', phase: 'Final review', schema: REREVIEW, model: 'sonnet', effort: 'medium' })
  if (!rr) return result('failed', { stage: 'final re-review' })
  const addressed = closed(rr)
  rr.new_findings.filter(f => f.severity === 'Minor').map(f => `${f.id} ${f.text}`).concat(rr.out_of_scope).forEach(x => deferred.push(`final ${x}`))
  finalOpen = finalOpen.filter(f => !addressed.has(f.id)).concat(rr.new_findings.filter(f => f.severity !== 'Minor'))
  if (finalOpen.length) {
    const r = await breaker(`The final whole-branch review's single fix wave left these findings open. There is no second wave.`, finalOpen, 'surface', 'final-breaker', 'Final review')
    if (!r) return result('failed', { stage: 'final breaker' })
    if (r.stop) return stop(r.stop_reason, 'final')
    for (const d of r.decisions) {
      const f = finalOpen.find(x => x.id === d.id) || { id: d.id, text: '' }
      if (d.decision === 'park') { rule(`Final: parked: ${f.id} ${f.text}; ruling: ${d.ruling}`); parked.push(`final ${f.id}: ${f.text}; ruling: ${d.ruling}`) }
      else { rule(`Final: ${d.ruling}`); surfaced.push(`${f.id}: ${f.text}; ruling: ${d.ruling}`) }
    }
    rule(...r.rulings.map(x => `Final: ${x}`))
  }
}

const dc = await deferralCheck(lastHead, 'Final review')
if (dc.failed) return result('failed', { stage: dc.failed })
if (dc.stop) return stop(dc.stop, 'deferral check', 'design')
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

Tasks:
${tasks.map(e => `- Task ${e.task}: ${e.title}. Commits ${e.commits}; review ${e.review}; ${e.rounds} fix round(s); ${e.parked} parked. Tests: ${e.tests}`).join('\n')}

Rulings:
${rulings.join('\n') || '(none)'}

Parked findings:
${parked.join('\n') || '(none)'}

Deferred minor findings:
${deferred.join('\n') || '(none)'}

Final review: ${final.summary}

Set aside by the final review as outside the plan (for a human to judge):
${(final.declined || []).join('\n') || '(none)'}
${finalFix ? `\nFinal fix:\n${finalFix}\n` : ''}
Surfaced for a human:
${surfaced.join('\n') || '(none)'}

Fill in the template. The description must stand on its own: state each decision in its own terms. Return the title and the body.`,
  { label: 'write-up', phase: 'Write-up', model: 'sonnet', effort: 'medium', schema: obj({ title: str, body: str }) })
if (!w) return result('failed', { stage: 'write-up' })

return result('done', { final_head: lastHead, plan: planText, scan: pre.scan, declined: final.declined, assumptions: plan.assumptions, follow_ups: plan.follow_ups, final_review: final.summary, tasks, surfaced, pr_title: w.title, pr_body: w.body })
