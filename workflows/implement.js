export const meta = {
  name: 'implement',
  description: 'dev-work: implement plan tasks in order, each with a task review and a capped fix loop',
  whenToUse: 'Started by the dev-work:develop skill; not meant to be run by hand.',
  phases: [{ title: 'Tasks', detail: 'per task: brief, implement, review, fix loop (cap 5)' }],
}

// args: { repo, runDir, planFile, sddDir, globalConstraints, startTask, taskCount, answers? }
//   sddDir: Superpowers' subagent-driven-development skill directory
//   answers: optional text the orchestrator gives a task that previously returned NEEDS_CONTEXT
const A = args
const CAP = 5
const NO_REMOTE = 'Commit on the current branch only. Do not push, create branches, open PRs, or touch any remote.'

const MECH = { type: 'object', properties: { head: { type: 'string' }, ok: { type: 'boolean' }, output: { type: 'string' } }, required: ['head', 'ok', 'output'] }
const IMPL = { type: 'object', properties: {
  status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'] },
  head_sha: { type: 'string' }, summary: { type: 'string' }, question: { type: 'string' },
  disputes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, evidence: { type: 'string' } }, required: ['id', 'evidence'] } } },
  required: ['status', 'head_sha', 'summary'] }
const FINDING = { type: 'object', properties: {
  id: { type: 'string' }, severity: { type: 'string', enum: ['Critical', 'Important', 'Minor'] }, text: { type: 'string' } },
  required: ['id', 'severity', 'text'] }
const REVIEW = { type: 'object', properties: {
  spec_verdict: { type: 'string', enum: ['pass', 'fail'] }, quality_verdict: { type: 'string', enum: ['Approved', 'Needs fixes'] },
  findings: { type: 'array', items: FINDING } }, required: ['spec_verdict', 'quality_verdict', 'findings'] }
const REREVIEW = { type: 'object', properties: {
  results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, addressed: { type: 'boolean' }, reason: { type: 'string' } }, required: ['id', 'addressed'] } },
  new_findings: { type: 'array', items: FINDING } }, required: ['results', 'new_findings'] }

const fill = (tpl, values) => `Read the prompt template ${A.sddDir}/${tpl}. Act as the subagent it describes: follow the prompt inside its code block with the placeholder values below. Leave the scene-setting placeholder empty. Work in the git repository ${A.repo}. Scripts written as scripts/... are in ${A.sddDir}/scripts/; run them with bash.
${Object.entries(values).map(([k, v]) => `- [${k}] = ${v}`).join('\n')}`
const mech = (cmd, label) => agent(`Run this shell command exactly, then report HEAD (\`git -C ${A.repo} rev-parse HEAD\`), whether the command succeeded, and its last 20 lines of output. Do nothing else.\n\n${cmd}`,
  { label, phase: 'Tasks', schema: MECH, model: 'haiku', effort: 'low' })
const list = fs => fs.map(f => `${f.id} (${f.severity}): ${f.text}`).join('\n')

phase('Tasks')
const tasks = []
let head = null
for (let n = A.startTask || 1; n <= A.taskCount; n++) {
  const brief = `${A.runDir}/task-${n}-brief.md`, report = `${A.runDir}/task-${n}-report.md`
  const prep = await mech(`cd ${A.repo} && bash ${A.sddDir}/scripts/task-brief ${A.planFile} ${n} ${brief}`, `brief-${n}`)
  if (!prep.ok) return { status: 'failed', stage: `brief for task ${n}`, detail: prep.output, tasks }
  const base = prep.head
  const entry = { task: n, base, rounds: [], parked: [], deferred_minor: [] }

  const impl = await agent(fill('implementer-prompt.md', { BRIEF_FILE: brief, REPORT_FILE: report }) +
    `\n${NO_REMOTE}\nThe binding global constraints: ${A.globalConstraints}` +
    (A.answers && n === A.startTask ? `\nAnswers to your earlier question, from the orchestrator: ${A.answers}` : '') +
    `\nIf you return NEEDS_CONTEXT or BLOCKED, put the exact question in "question". Return the HEAD sha after your work.`,
    { label: `implement-${n}`, phase: 'Tasks', schema: IMPL, model: 'sonnet', effort: 'medium' })
  entry.implementer = impl.status
  if (impl.status === 'NEEDS_CONTEXT' || impl.status === 'BLOCKED') {
    tasks.push(entry)
    return { status: 'needs_orchestrator', task: n, implementer: impl.status, question: impl.question || impl.summary, tasks }
  }
  head = impl.head_sha

  const diff = `${A.runDir}/review-${n}-0.diff`
  const pkg = await mech(`cd ${A.repo} && bash ${A.sddDir}/scripts/review-package ${A.planFile} ${base} ${head} ${diff}`, `package-${n}`)
  if (!pkg.ok) return { status: 'failed', stage: `review package for task ${n}`, detail: pkg.output, tasks }
  const review = await agent(fill('task-reviewer-prompt.md', { BRIEF_FILE: brief, GLOBAL_CONSTRAINTS: A.globalConstraints, REPORT_FILE: report,
    BASE_SHA: base, HEAD_SHA: head, DIFF_FILE: diff }) +
    `\nReport every spec gap as a finding too (Critical or Important). Give findings ids T${n}-1, T${n}-2…. Do not modify the repository.`,
    { label: `review-${n}`, phase: 'Tasks', schema: REVIEW, model: 'sonnet', effort: 'medium' })
  entry.review = { spec: review.spec_verdict, quality: review.quality_verdict, findings: review.findings.length }
  entry.deferred_minor = review.findings.filter(f => f.severity === 'Minor')
  let open = review.findings.filter(f => f.severity !== 'Minor')
  const disputes = {}

  let round = 0
  while (open.length && round < CAP) {
    round++
    const model = round <= 3 ? 'sonnet' : 'opus'
    const fixBase = head
    const fix = await agent(fill('implementer-prompt.md', { BRIEF_FILE: brief, REPORT_FILE: report }) +
      `\n${NO_REMOTE}\nFix round ${round}${round > 3 ? ' (you are taking over: read the report file for what was tried)' : ''}. The task is implemented; address only these review findings, append a fix report with the test command and its output to the report file, and commit:\n${list(open)}
If a finding is wrong, do not change code for it: dispute it with concrete evidence (a cited file:line, or a test and its output) in "disputes". A stated preference is not evidence.
Return the HEAD sha after your fix.`,
      { label: `fix-${n}-r${round}`, phase: 'Tasks', schema: IMPL, model, effort: round <= 3 ? 'medium' : 'high' })
    head = fix.head_sha
    ;(fix.disputes || []).forEach(d => { disputes[d.id] = d.evidence })
    const rdiff = `${A.runDir}/review-${n}-${round}.diff`
    const rpkg = await mech(`cd ${A.repo} && bash ${A.sddDir}/scripts/review-package ${A.planFile} ${fixBase} ${head} ${rdiff}`, `package-${n}-r${round}`)
    if (!rpkg.ok) { entry.rounds.push({ round, note: 'no new commits in fix round' }); continue }
    const rr = await agent(fill('re-review-prompt.md', { BRIEF_FILE: brief, FINDINGS: list(open), REPORT_FILE: report,
      FIX_BASE_SHA: fixBase, HEAD_SHA: head, DIFF_FILE: rdiff }) +
      (Object.keys(disputes).length ? `\nThe implementer disputes these findings with evidence; mark one addressed if the evidence concretely refutes it:\n${Object.entries(disputes).map(([k, v]) => `${k}: ${v}`).join('\n')}` : '') +
      `\nGive new findings ids T${n}-R${round}-1…. Do not modify the repository.`,
      { label: `re-review-${n}-r${round}`, phase: 'Tasks', schema: REREVIEW, model: 'sonnet', effort: 'medium' })
    const notAddressed = new Set(rr.results.filter(r => !r.addressed).map(r => r.id))
    const fresh = rr.new_findings.filter(f => f.severity !== 'Minor')
    entry.deferred_minor.push(...rr.new_findings.filter(f => f.severity === 'Minor'))
    entry.rounds.push({ round, model, fixer: fix.status, not_addressed: [...notAddressed], new_blocking: fresh.map(f => f.id) })
    open = open.filter(f => notAddressed.has(f.id)).concat(fresh)
  }
  entry.parked = open.map(f => ({ ...f, dispute: disputes[f.id] || null }))
  entry.final_head = head
  entry.deferred_minor = entry.deferred_minor.map(f => `${f.id}: ${f.text}`)
  tasks.push(entry)
  log(`Task ${n}: ${entry.rounds.length} fix round(s), ${entry.parked.length} parked at the cap`)
}
return { status: 'done', final_head: head, tasks }
