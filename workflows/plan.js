export const meta = {
  name: 'plan',
  description: 'dev-work: write a plan, review it (plan reviewer and skeptic), revise once, re-check',
  whenToUse: 'Started by the dev-work:develop skill; not meant to be run by hand.',
  phases: [
    { title: 'Write', detail: 'planner writes the plan with superpowers:writing-plans' },
    { title: 'Review', detail: 'plan reviewer questions and skeptic objections, in parallel' },
    { title: 'Revise', detail: 'one revision: change the plan or rebut each objection' },
    { title: 'Re-check', detail: 'each item addressed or not; new problems in changed parts only' },
  ],
}

// args: { repo, runDir, scopeFile, planFile, failureReport? }
const A = args
const LOC = { type: 'object', properties: { skills_dir: { type: 'string' } }, required: ['skills_dir'] }
// Superpowers' location comes from Claude Code itself, never from an assumed path.
const locateSuperpowers = async ph => (await agent(`Use the Skill tool to load the skill "superpowers:writing-plans". Do not follow its instructions. The loaded text begins with a line "Base directory for this skill: <path>". Return the parent of that path (the directory that contains writing-plans/) as skills_dir. Do nothing else.`,
  { label: 'locate-superpowers', phase: ph, schema: LOC, model: 'haiku', effort: 'low' })).skills_dir
const UNATTENDED = `You are running unattended inside an automated pipeline. Nobody will answer questions. Do not offer choices or ask for approval; where a skill tells you to ask the user, make a reasonable call yourself and record it under "Assumptions". Do not push, open PRs, or touch any remote.`
const FORMAT = `Plan format (required):
- Save the plan to ${A.planFile}, not under docs/. Do not commit it.
- First line after the title: "**Global constraints:**" followed by the binding requirements copied verbatim from the scope (language, test command, style rules).
- Each task is a heading "### Task N: <name>" with **Files:**, **Interfaces:** (exact signatures consumed and produced) and test-first steps, each with its expected outcome.
- Prefer few tasks, done in order. With more than one task, the last is an integration task that checks the whole change against the scope end to end.
- No placeholders or TODOs. End with an "## Assumptions" section (may be empty).`

const PLAN_OUT = { type: 'object', properties: {
  task_count: { type: 'integer' }, size: { type: 'string', enum: ['small', 'medium', 'large'] },
  summary: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } } },
  required: ['task_count', 'size', 'summary'] }
const REVIEW_OUT = { type: 'object', properties: {
  status: { type: 'string', enum: ['Approved', 'Issues Found'] },
  issues: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
  questions: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, text: { type: 'string' }, pile: { type: 'string', enum: ['answered', 'minor', 'blocking'] }, suggestion: { type: 'string' } },
    required: ['id', 'text', 'pile'] } } }, required: ['status', 'issues', 'questions'] }
const OBJ_OUT = { type: 'object', properties: { objections: { type: 'array', items: { type: 'object', properties: {
  id: { type: 'string' }, text: { type: 'string' }, consequence: { type: 'string' } }, required: ['id', 'text', 'consequence'] } } },
  required: ['objections'] }
const REV_OUT = { type: 'object', properties: { responses: { type: 'array', items: { type: 'object', properties: {
  id: { type: 'string' }, action: { type: 'string', enum: ['revised', 'rebutted'] }, note: { type: 'string' } }, required: ['id', 'action', 'note'] } },
  task_count: { type: 'integer' } }, required: ['responses', 'task_count'] }
const RECHECK_OUT = { type: 'object', properties: {
  results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, addressed: { type: 'boolean' }, reason: { type: 'string' } }, required: ['id', 'addressed', 'reason'] } },
  new_problems: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, consequence: { type: 'string' } }, required: ['id', 'text', 'consequence'] } } },
  required: ['results', 'new_problems'] }

phase('Write')
const SP = await locateSuperpowers('Write')
const plan = await agent(`Use the superpowers:writing-plans skill to write an implementation plan for the scope in ${A.scopeFile}, for the git repository at ${A.repo}. Explore the code as the skill describes.
${UNATTENDED}
${FORMAT}
${A.failureReport ? `A previous run of this pipeline failed. Read its failure report first and do not repeat the design it rejected: ${A.failureReport}` : ''}
Return the task count, a size (small: one or two simple tasks; large: many tasks or risky changes), a two-sentence summary, and your assumptions.`,
  { label: 'planner', phase: 'Write', schema: PLAN_OUT, model: 'opus', effort: 'high' })

phase('Review')
const reviewerTemplate = `${SP}/writing-plans/plan-document-reviewer-prompt.md`
const [review, skeptic] = await parallel([
  () => agent(`Read the prompt template ${reviewerTemplate}. Act as the subagent it describes, following the prompt inside its code block, with [PLAN_FILE_PATH] = ${A.planFile} and [SPEC_FILE_PATH] = ${A.scopeFile}. The repository is ${A.repo}; you may read code but must not modify anything.
In addition, list the questions an implementer would still need answered before building. Sort each into a pile: "answered" (the plan already answers it), "minor" (you would make the call yourself; give your suggestion) or "blocking" (the answer changes what gets built). Give issues ids I1, I2… and questions ids Q1, Q2….`,
    { label: 'plan-reviewer', phase: 'Review', schema: REVIEW_OUT, model: 'sonnet', effort: 'medium' }),
  () => plan.size === 'small' ? Promise.resolve({ objections: [], skipped: true }) :
    agent(`This is not a debate: there is one round and no reply. Read the scope in ${A.scopeFile} and the plan in ${A.planFile} for the repository at ${A.repo}. Do not write or edit any file.
Return objections to the design only: a wrong approach, a missed simpler alternative, an unnamed risk, or scope creep. Each must name the concrete consequence if the plan is built as written. "Could be better" is not an objection, and neither is wording or style. An empty list is a valid answer. Give ids O1, O2….`,
      { label: 'skeptic', phase: 'Review', schema: OBJ_OUT, model: 'opus', effort: 'high', agentType: 'ai-workspace:skeptic' }),
])

const items = [
  ...review.issues.map(i => ({ id: i.id, kind: 'issue', text: i.text })),
  ...review.questions.filter(q => q.pile === 'blocking').map(q => ({ id: q.id, kind: 'blocking question', text: q.text })),
  ...skeptic.objections.map(o => ({ id: o.id, kind: 'objection', text: `${o.text} (consequence: ${o.consequence})` })),
]
const minorCalls = review.questions.filter(q => q.pile === 'minor')
let responses = { responses: [], task_count: plan.task_count }
let recheck = { results: [], new_problems: [] }

if (items.length || minorCalls.length) {
  phase('Revise')
  responses = await agent(`Revise the implementation plan at ${A.planFile} once, for the repository at ${A.repo} and the scope in ${A.scopeFile}.
${UNATTENDED}
Keep the plan format rules:
${FORMAT}
Respond to every item below. For issues and blocking questions, change the plan. For each objection, either revise the plan or rebut it with a concrete reason.
${items.map(i => `${i.id} (${i.kind}): ${i.text}`).join('\n') || '(none)'}
Also record these minor calls in the plan's Assumptions, using the suggestion unless you have a concrete reason not to:
${minorCalls.map(q => `${q.id}: ${q.text} → ${q.suggestion || 'your call'}`).join('\n') || '(none)'}
Return one response per item id, and the plan's task count after revision.`,
    { label: 'planner-revise', phase: 'Revise', schema: REV_OUT, model: 'opus', effort: 'high' })

  if (items.length) {
    phase('Re-check')
    recheck = await agent(`Re-check a revised implementation plan at ${A.planFile} (scope: ${A.scopeFile}, repository: ${A.repo}). Do not modify anything.
For each item below, decide whether the revision addressed it. "Attempted" is not addressed; neither is acknowledging an item or promising to deal with it later. A rebuttal counts as addressed only if its reason is concrete and correct.
Then look for new problems that would cause a wrong build, in the parts of the plan that changed only. Do not raise anything else.
Items:
${items.map(i => `${i.id} (${i.kind}): ${i.text}`).join('\n')}
Responses from the planner:
${responses.responses.map(r => `${r.id}: ${r.action}: ${r.note}`).join('\n')}`,
      { label: 'plan-recheck', phase: 'Re-check', schema: RECHECK_OUT, model: 'opus', effort: 'high' })
  }
}

const open = recheck.results.filter(r => !r.addressed).map(r => ({ ...items.find(i => i.id === r.id), reason: r.reason }))
return {
  planFile: A.planFile,
  task_count: responses.task_count || plan.task_count,
  size: plan.size,
  summary: plan.summary,
  assumptions: plan.assumptions || [],
  reviewer_status: review.status,
  skeptic_skipped: !!skeptic.skipped,
  items, responses: responses.responses,
  open, new_problems: recheck.new_problems,
}
