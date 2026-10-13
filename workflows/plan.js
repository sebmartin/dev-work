export const meta = {
  name: 'plan',
  description: 'dev-work: write a plan, review it (plan reviewer and skeptic), revise once, re-check',
  whenToUse: 'Started by a dev-work workflow skill.',
  phases: [{ title: 'Write' }, { title: 'Review' }, { title: 'Revise' }, { title: 'Re-check' }],
}

// args: { repo, runDir, scopeFile, planFile, failureReport? }
const A = args
const UNATTENDED = 'Nobody will answer questions: where you would ask, make the call and record it under Assumptions. Do not push or touch any remote.'
const FORMAT = `Save the plan to ${A.planFile}; don't commit it. Start with a "Global constraints:" line copied verbatim from the scope. Each task is "### Task N: <name>" with Files, Interfaces (exact signatures consumed and produced) and test-first steps, each with its expected outcome. No placeholders or TODO text. Prefer few tasks, in order; with more than one, the last checks the whole change against the scope. End with "## Assumptions".`

const str = { type: 'string' }
const item = props => ({ type: 'object', properties: props, required: Object.keys(props) })
const list = props => ({ type: 'array', items: item(props) })

phase('Write')
const plan = await agent(`Use the superpowers:writing-plans skill to plan the scope in ${A.scopeFile} for the repository at ${A.repo}. ${UNATTENDED}
${FORMAT}${A.failureReport ? `\nA previous attempt failed; read ${A.failureReport} and don't repeat its design.` : ''}`,
  { label: 'planner', phase: 'Write', model: 'opus', effort: 'high', schema: item({
    task_count: { type: 'integer' }, size: { type: 'string', enum: ['small', 'medium', 'large'] }, summary: str }) })

phase('Review')
const [review, skeptic] = await parallel([
  () => agent(`Follow the plan document reviewer prompt from the superpowers:writing-plans skill for the plan ${A.planFile} against the spec ${A.scopeFile} (repository ${A.repo}; read only).
Also list the questions an implementer would still need answered, each sorted as "answered" (the plan answers it), "minor" (give your suggestion) or "blocking" (the answer changes what gets built). Ids: I1… for issues, Q1… for questions.`,
    { label: 'plan-reviewer', phase: 'Review', model: 'sonnet', effort: 'medium', schema: item({
      issues: list({ id: str, text: str }),
      questions: list({ id: str, text: str, pile: { type: 'string', enum: ['answered', 'minor', 'blocking'] }, suggestion: str }) }) }),
  () => plan.size === 'small' ? Promise.resolve({ objections: [] }) :
    agent(`One round, no debate. Read the scope ${A.scopeFile} and the plan ${A.planFile} (repository ${A.repo}; read only). Return objections to the design only (a wrong approach, a missed simpler alternative, an unnamed risk, scope creep), each with its concrete consequence. "Could be better" is not an objection. Ids O1…; an empty list is fine.`,
      { label: 'skeptic', phase: 'Review', model: 'opus', effort: 'high', agentType: 'ai-workspace:skeptic',
        schema: item({ objections: list({ id: str, text: str, consequence: str }) }) }),
])

const items = [
  ...review.issues.map(i => `${i.id} (issue): ${i.text}`),
  ...review.questions.filter(q => q.pile === 'blocking').map(q => `${q.id} (blocking question): ${q.text}`),
  ...skeptic.objections.map(o => `${o.id} (objection): ${o.text} — consequence: ${o.consequence}`),
]
const minor = review.questions.filter(q => q.pile === 'minor').map(q => `${q.id}: ${q.text} → ${q.suggestion || 'your call'}`)
let responses = [], recheck = { results: [], new_problems: [] }, taskCount = plan.task_count

if (items.length || minor.length) {
  phase('Revise')
  const rev = await agent(`Revise the plan ${A.planFile} once (scope ${A.scopeFile}, repository ${A.repo}). ${UNATTENDED} ${FORMAT}
Respond to every item: change the plan for issues and blocking questions; revise or rebut each objection with a concrete reason.
${items.join('\n') || '(none)'}
Record these minor calls under Assumptions, using the suggestion unless you have a concrete reason not to:
${minor.join('\n') || '(none)'}`,
    { label: 'planner-revise', phase: 'Revise', model: 'opus', effort: 'high', schema: item({
      responses: list({ id: str, action: { type: 'string', enum: ['revised', 'rebutted'] }, note: str }), task_count: { type: 'integer' } }) })
  responses = rev.responses
  taskCount = rev.task_count

  if (items.length) {
    phase('Re-check')
    recheck = await agent(`Re-check the revised plan ${A.planFile} (scope ${A.scopeFile}, repository ${A.repo}; read only).
For each item, decide whether it was addressed. "Attempted", acknowledged or deferred is not addressed; a rebuttal counts only if its reason is concrete and correct.
Then list new problems that would cause a wrong build, in the changed parts only.
Items:\n${items.join('\n')}
Planner's responses:\n${responses.map(r => `${r.id}: ${r.action}: ${r.note}`).join('\n')}`,
      { label: 'plan-recheck', phase: 'Re-check', model: 'opus', effort: 'high', schema: item({
        results: list({ id: str, addressed: { type: 'boolean' }, reason: str }),
        new_problems: list({ id: str, text: str, consequence: str }) }) })
  }
}

return {
  task_count: taskCount, size: plan.size, summary: plan.summary, responses,
  open: recheck.results.filter(r => !r.addressed).map(r => ({ id: r.id, item: items.find(i => i.startsWith(`${r.id} `)), reason: r.reason })),
  new_problems: recheck.new_problems,
}
