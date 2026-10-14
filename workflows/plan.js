export const meta = {
  name: 'plan',
  description: 'dev-work: turn an approved design into a plan of tasks with superpowers:writing-plans',
  whenToUse: 'Started by a dev-work workflow skill.',
  phases: [{ title: 'Plan' }],
}

// args: { thread?, repo, runDir, designFile, planFile, failureReport? }
const A = args
const ag = (prompt, opts) => agent(A.thread ? `${prompt}\nThe ai-workspace thread "${A.thread}" holds this work's background and decisions; read it when it helps. It is private: nothing from it goes into anything that could be published (code, comments, docs, commit messages, PR text, replies) unless it stands on its own for a stranger. Never name the thread, its notes or ids, or the people in it.` : prompt, opts)

const str = { type: 'string' }
const obj = (props, req = Object.keys(props)) => ({ type: 'object', properties: props, required: req })
const strs = { type: 'array', items: str }

phase('Plan')
const plan = await ag(`Use the superpowers:writing-plans skill to turn the approved design in ${A.designFile} into an implementation plan for the repository at ${A.repo}. The design is already decided and reviewed: plan it, don't redesign it.
- Save the plan to ${A.planFile}; don't commit it.
- Plan only what the design asks. List anything else worth doing under "## Follow-ups" instead of planning it.
- Write a "Global constraints:" line only if the design states constraints, copied from it.
- You may read code and run the repository's existing commands (tests, linters, build) to learn its baseline. Do not write or run new code to check the plan; proving it works is the implementation's job.
- Nobody will answer questions: where you would ask, make the call and record it under "## Assumptions". Do not push or touch any remote.${A.failureReport ? `\nA previous attempt failed; read ${A.failureReport} first.` : ''}`,
  { label: 'planner', phase: 'Plan', model: 'opus', effort: 'medium', schema: obj({
    task_count: { type: 'integer' }, summary: str, global_constraints: str, assumptions: strs, follow_ups: strs },
    ['task_count', 'summary', 'assumptions', 'follow_ups']) })

return { status: 'done', ...plan }
