export const meta = {
  name: 'implement',
  description: 'dev-work: implement plan tasks in order, each with a task review and a capped fix loop',
  whenToUse: 'Started by a dev-work workflow skill.',
  phases: [{ title: 'Tasks' }],
}

// args: { thread?, repo, runDir, planFile, globalConstraints, startTask, taskCount, answers? }
const A = args
const ag = (prompt, opts) => agent(A.thread ? `${prompt}\nThe ai-workspace thread "${A.thread}" holds this work's background and decisions; read it when it helps. It is private: nothing from it goes into anything that could be published (code, comments, docs, commit messages, PR text, replies) unless it stands on its own for a stranger. Never name the thread, its notes or ids, or the people in it.` : prompt, opts)
const CAP = 5
const SDD = 'the superpowers:subagent-driven-development skill'
const LOCAL = 'Commit on the current branch only; do not push or touch any remote.'

const str = { type: 'string' }
const obj = (props, req = Object.keys(props)) => ({ type: 'object', properties: props, required: req })
const FINDING = obj({ id: str, severity: { type: 'string', enum: ['Critical', 'Important', 'Minor'] }, text: str })
const MECH = obj({ head: str, ok: { type: 'boolean' }, output: str })
const IMPL = obj({ status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'] }, head_sha: str, summary: str, question: str,
  disputes: { type: 'array', items: obj({ id: str, evidence: str }) } }, ['status', 'head_sha', 'summary'])
const REVIEW = obj({ spec_verdict: { type: 'string', enum: ['pass', 'fail'] }, quality_verdict: { type: 'string', enum: ['Approved', 'Needs fixes'] },
  findings: { type: 'array', items: FINDING } })
const REREVIEW = obj({ results: { type: 'array', items: obj({ id: str, addressed: { type: 'boolean' } }) }, new_findings: { type: 'array', items: FINDING } })

const mech = (what, label) => ag(`In ${A.repo}: ${what} Report HEAD, whether it succeeded, and the output.`,
  { label, phase: 'Tasks', schema: MECH, model: 'haiku', effort: 'low' })
const template = (name, values) => `Follow the ${name} prompt template from ${SDD}, working in ${A.repo}, with: ${Object.entries(values).map(([k, v]) => `${k} = ${v}`).join('; ')}.`
const fmt = fs => fs.map(f => `${f.id} (${f.severity}): ${f.text}`).join('\n')

phase('Tasks')
const tasks = []
let head = null
for (let n = A.startTask || 1; n <= A.taskCount; n++) {
  const brief = `${A.runDir}/task-${n}-brief.md`, report = `${A.runDir}/task-${n}-report.md`
  const prep = await mech(`extract task ${n} of ${A.planFile} into ${brief} with ${SDD}'s task-brief script.`, `brief-${n}`)
  if (!prep.ok) return { status: 'failed', stage: `brief ${n}`, detail: prep.output, tasks }
  const base = prep.head, entry = { task: n, base, rounds: [] }

  const impl = await ag(template('implementer', { brief: brief, report: report }) + ` ${LOCAL} Global constraints: ${A.globalConstraints}` +
    (A.answers && n === A.startTask ? ` Answer to your earlier question: ${A.answers}` : ''),
    { label: `implement-${n}`, phase: 'Tasks', schema: IMPL, model: 'sonnet', effort: 'medium' })
  if (impl.status === 'NEEDS_CONTEXT' || impl.status === 'BLOCKED')
    return { status: 'needs_orchestrator', task: n, question: impl.question || impl.summary, tasks }
  head = impl.head_sha

  const diff = `${A.runDir}/review-${n}-0.diff`
  const pkg = await mech(`write the review package for ${base}..${head} to ${diff} with ${SDD}'s review-package script (plan ${A.planFile}).`, `package-${n}`)
  if (!pkg.ok) return { status: 'failed', stage: `package ${n}`, detail: pkg.output, tasks }
  const review = await ag(template('task reviewer', { brief, report, 'global constraints': A.globalConstraints, base, head, 'diff file': diff }) +
    ` Report every spec gap as a finding too. Ids T${n}-1…. Read only.`,
    { label: `review-${n}`, phase: 'Tasks', schema: REVIEW, model: 'sonnet', effort: 'medium' })
  entry.review = `${review.spec_verdict}, ${review.quality_verdict}`
  entry.deferred_minor = review.findings.filter(f => f.severity === 'Minor').map(f => `${f.id}: ${f.text}`)
  let open = review.findings.filter(f => f.severity !== 'Minor')
  const disputes = {}

  for (let round = 1; open.length && round <= CAP; round++) {
    const fixBase = head
    const fix = await ag(template('implementer', { brief, report }) + ` ${LOCAL}
Fix round ${round}${round > 3 ? ' (taking over: read the report for what was tried)' : ''}: address only these findings, append a fix report with the test command and output, and commit.
${fmt(open)}
If a finding is wrong, don't change code for it: dispute it with concrete evidence (a cited file:line, or a test and its output). A stated preference is not evidence.`,
      { label: `fix-${n}-r${round}`, phase: 'Tasks', schema: IMPL, model: round <= 3 ? 'sonnet' : 'opus', effort: round <= 3 ? 'medium' : 'high' })
    head = fix.head_sha
    ;(fix.disputes || []).forEach(d => { disputes[d.id] = d.evidence })
    const rdiff = `${A.runDir}/review-${n}-${round}.diff`
    const rpkg = await mech(`write the review package for ${fixBase}..${head} to ${rdiff} with ${SDD}'s review-package script (plan ${A.planFile}).`, `package-${n}-r${round}`)
    if (!rpkg.ok) { entry.rounds.push({ round, note: 'no new commits' }); continue }
    const rr = await ag(template('re-review', { brief, report, findings: fmt(open), 'fix base': fixBase, head, 'diff file': rdiff }) +
      (Object.keys(disputes).length ? `\nDisputed with evidence (addressed if the evidence concretely refutes it):\n${Object.entries(disputes).map(([k, v]) => `${k}: ${v}`).join('\n')}` : '') +
      ` New finding ids T${n}-R${round}-1…. Read only.`,
      { label: `re-review-${n}-r${round}`, phase: 'Tasks', schema: REREVIEW, model: 'sonnet', effort: 'medium' })
    const notAddressed = new Set(rr.results.filter(r => !r.addressed).map(r => r.id))
    const fresh = rr.new_findings.filter(f => f.severity !== 'Minor')
    entry.deferred_minor.push(...rr.new_findings.filter(f => f.severity === 'Minor').map(f => `${f.id}: ${f.text}`))
    entry.rounds.push({ round, not_addressed: [...notAddressed], new: fresh.map(f => f.id) })
    open = open.filter(f => notAddressed.has(f.id)).concat(fresh)
  }
  entry.parked = open.map(f => ({ ...f, dispute: disputes[f.id] || null }))
  entry.final_head = head
  tasks.push(entry)
  log(`Task ${n}: ${entry.rounds.length} fix round(s), ${entry.parked.length} parked`)
}
return { status: 'done', final_head: head, tasks }
