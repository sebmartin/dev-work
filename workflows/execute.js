export const meta = {
  name: 'execute',
  description: 'dev-work: run a plan the way superpowers:subagent-driven-development does, with this script as its controller',
  whenToUse: 'Started by the dev-work develop skill.',
  phases: [{ title: 'Setup' }, { title: 'Tasks' }, { title: 'Final review' }, { title: 'Review feedback' }],
}

// args: { repo, planFile, designFile, baseSha, feedback?, round? }
// With feedback (a list of { id, text } from a human review of the PR), it runs only fix rounds on that feedback.
// Follows SDD v7 section by section, using its prompt templates, scripts and ledger. Where SDD leaves a
// call to its controller, a ruler agent makes it. Fix rounds dispatch a fresh implementer with the
// report file (SDD's fallback when a subagent can't be resumed). Reviewers package their own diffs, a
// Sonnet checker resolves what a reviewer couldn't verify, and the pre-flight result is kept in the ledger.
const A = args
// Every agent is a dev-work worker: it gets only its prompt and the files it names, never the threads tools.
const ag = (prompt, opts = {}) => agent(prompt, { agentType: 'dev-work:worker', ...opts })
const SDD = 'the superpowers:subagent-driven-development skill'
const LOCAL = 'Work only in this checkout: commit on the current branch, never push or touch a remote. Add every change as a new commit: never amend, rebase, reset or otherwise rewrite commits, and never force-add ignored files (no `git add -f`); run files stay uncommitted. Put any scratch files in .dev-work/scratch/ in this checkout, never in /tmp or anywhere else.'
const CAP = 5
const TIERS = ['haiku', 'sonnet', 'opus']
const up = m => TIERS[Math.min(TIERS.indexOf(m) + 1, TIERS.length - 1)]
const effort = m => (m === 'opus' ? 'high' : 'medium')
const atLeast = (m, floor) => TIERS[Math.max(TIERS.indexOf(m), TIERS.indexOf(floor))]

const str = { type: 'string' }, bool = { type: 'boolean' }
const obj = (props, req = Object.keys(props)) => ({ type: 'object', properties: props, required: req })
const arr = items => ({ type: 'array', items })
const SEV = { type: 'string', enum: ['Critical', 'Important', 'Minor'] }
const FINDING = obj({ id: str, severity: SEV, text: str, plan_mandated: bool }, ['id', 'severity', 'text'])
const MECH = obj({ head: str, ok: bool, output: str })
const IMPL = obj({ status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'] }, head_sha: str, summary: str, details: str },
  ['status', 'head_sha', 'summary'])
const REVIEW = obj({ spec_verdict: { type: 'string', enum: ['pass', 'fail'] }, cannot_verify: arr(str), quality_verdict: { type: 'string', enum: ['Approved', 'Needs fixes'] }, findings: arr(FINDING) })
const REREVIEW = obj({ results: arr(obj({ id: str, addressed: bool })), new_findings: arr(FINDING), out_of_scope: arr(str), rewrote_history: bool }, ['results', 'new_findings', 'out_of_scope'])
const RULINGS = { rulings: arr(str), stop: bool, stop_reason: str }

// ---------- ledger: lines queue here and are appended by the next mechanics agent ----------
let ws = null, ledgerFile = null
const pending = [], rulings = [], parked = [], deferred = [], carry = []
const note = (...lines) => pending.push(...lines)
const rule = (...lines) => { rulings.push(...lines); note(...lines) }
const mech = async (what, label, phase) => {
  const flush = pending.length ? `First append these lines to ${ledgerFile}, verbatim, one per line:\n${pending.join('\n')}\nThen: ` : ''
  const r = await ag(`In ${A.repo}: ${flush}${what} Report HEAD, whether it succeeded, and the output.`, { label, phase, schema: MECH, model: 'haiku', effort: 'low' })
  if (r.ok) pending.length = 0
  return r
}
const fmt = fs => fs.map(f => `${f.id} (${f.severity}): ${f.text}`).join('\n')
const same = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a))
// Reviewers build their own review package, so no separate agent runs the script.
const pkgOf = (from, to) => `the file printed by running ${SDD}'s review-package script with ${A.planFile} ${from} ${to} (run it yourself first)`
const fixRange = (fixBase, head, taskBase) => `If ${fixBase} is not an ancestor of ${head} (\`git merge-base --is-ancestor\`), the fix rewrote history: package ${taskBase}..${head} instead, judge the findings against that, and set rewrote_history. If there are no commits after ${fixBase}, verify the findings from the fix report and any files it names.`
const template = (name, values, skill = SDD) => `Follow the ${name} prompt template from ${skill}, working in ${A.repo}, with: ${Object.entries(values).map(([k, v]) => `${k} = ${v}`).join('; ')}.`

// The ruler makes the calls SDD leaves to its controller.
const ruler = (question, schema, label, phase) => ag(`You make the calls ${SDD} leaves to its controller, for the plan ${A.planFile} in ${A.repo}. The design ${A.designFile} is the binding authority, the plan is its argument, and your judgment settles what neither answers. Read the code as needed; don't change it.
Rulings so far:\n${rulings.join('\n') || '(none)'}
${question}
Write every decision as "Ruling: <what you decided> — <why> — <what it costs if wrong>". Decide; nobody will answer questions. Set stop only for an irreversible or destructive operation, a security-sensitive action, or a plan so broken that every path forward is a guess, and say why in stop_reason.`,
  { label, phase, schema, model: 'opus', effort: 'high' })

const result = (status, extra = {}) => ({ status, ...extra, rulings, parked, deferred, carried: carry })
const fail = async (stage, detail, ph) => {
  if (pending.length) await mech('nothing else.', 'ledger-fail', ph)
  return result('failed', { stage, detail })
}
const stop = async (reason, at) => {
  note(`Stopped at ${at}: ${reason}`)
  await mech('nothing else.', 'ledger-stop', at === 'final' ? 'Final review' : 'Tasks')
  return result('stopped', { at, reason })
}

// ---------- Setup ----------
phase('Setup')
const setup = await ag(`In ${A.repo}: run ${SDD}'s sdd-workspace script with ${A.planFile} and report the directory it prints as workspace. If <workspace>/progress.md exists and its first line names this plan, return its full contents as ledger; otherwise create it containing only the line "# SDD ledger — plan: ${A.planFile}" and return ledger as an empty string. Report HEAD.`,
  { label: 'workspace', phase: 'Setup', model: 'haiku', effort: 'low', schema: obj({ workspace: str, ledger: str, head: str }) })
ws = setup.workspace
ledgerFile = `${ws}/progress.md`
const prior = setup.ledger || ''
const done = new Set([...prior.matchAll(/^Task (\d+): complete/gm)].map(m => Number(m[1])))
rulings.push(...prior.split('\n').filter(l => l.includes('Ruling:')))
if (prior) log(`Resuming: ${done.size} task(s) complete in the ledger`)

// ---------- Review feedback: fix rounds on a human's review of the PR ----------
if (A.feedback) {
  phase('Review feedback')
  const R = A.round || 1, report = `${A.repo}/.dev-work/round-${R}-report.md`
  let open = A.feedback.map((f, i) => ({ id: f.id || `PR${R}-${i + 1}`, severity: 'Important', text: f.text }))
  let head = setup.head
  const outcome = {}
  for (let round = 1; open.length && round <= CAP; round++) {
    const fixBase = head, fixModel = round <= 3 ? 'sonnet' : 'opus'
    const fix = await ag(`In ${A.repo}: a reviewer left this feedback on the pull request for this branch (plan ${A.planFile}, design ${A.designFile}). ${round <= 3 ? `Fix round ${round} of ${CAP}.` : `Earlier attempts are recorded in ${report}; you own the remaining items now.`} Address each item, re-run the tests that cover what you change, append a fix report (per item: what changed, or why nothing should change, with evidence; covering tests, command, output) to ${report}, and commit. If an item is wrong or would contradict the design, don't change code for it: explain why in the report. ${LOCAL} Do not dispatch subagents.
${fmt(open)}`,
      { label: `feedback-fix-r${round}`, phase: 'Review feedback', schema: IMPL, model: fixModel, effort: effort(fixModel) })
    head = fix.head_sha
    const rr = await ag(template('re-review', { 'brief file': A.planFile, 'findings': fmt(open), 'report file': report, 'fix base': fixBase, 'head': head, 'diff file': pkgOf(fixBase, head) }) + ` ${fixRange(fixBase, head, fixBase)} A finding counts as addressed if it was fixed, or if the report shows with evidence that it should not change. New finding ids PR${R}-R${round}-1…; out-of-scope observations in out_of_scope.`,
      { label: `feedback-re-review-r${round}`, phase: 'Review feedback', schema: REREVIEW, model: 'sonnet', effort: 'medium' })
    const notAddressed = new Set(rr.results.filter(r => !r.addressed).map(r => r.id))
    open.filter(f => !notAddressed.has(f.id)).forEach(f => { outcome[f.id] = 'addressed' })
    rr.out_of_scope.forEach(t => { deferred.push(`round ${R} ${t}`); note(`Round ${R}: minor (deferred): ${t}`) })
    const before = open.length
    open = open.filter(f => notAddressed.has(f.id)).concat(rr.new_findings.filter(f => f.severity !== 'Minor'))
    note(`Round ${R}: fix round ${round}/${CAP} (${before - notAddressed.size} addressed, ${open.length} open; commits ${fixBase.slice(0, 7)}..${head.slice(0, 7)})`)
  }
  const surfaced = []
  if (open.length) {
    const r = await ruler(`Review round ${R} on the pull request hit its cap of ${CAP} fix rounds (report ${report}). Adjudicate each open item as SDD's breaker says: park it (the comment is wrong or contestable, or real but not needed for this change), or surface it for the human, with your ruling.
${fmt(open)}`,
      obj({ decisions: arr(obj({ id: str, decision: { type: 'string', enum: ['park', 'surface'] }, ruling: str })), ...RULINGS }, ['decisions', 'rulings', 'stop']), `feedback-breaker`, 'Review feedback')
    if (r.stop) return await stop(r.stop_reason, `round ${R}`)
    for (const d of r.decisions) {
      const f = open.find(x => x.id === d.id) || { id: d.id, text: '' }
      outcome[d.id] = `${d.decision}: ${d.ruling}`
      if (d.decision === 'park') { rule(`Round ${R}: parked — ${f.id} ${f.text} — ${d.ruling}`); parked.push(`round ${R} ${f.id}: ${f.text} — ${d.ruling}`) }
      else { rule(`Round ${R}: ${d.ruling}`); surfaced.push(`${f.id}: ${f.text} — ${d.ruling}`) }
    }
    rule(...r.rulings.map(x => `Round ${R}: ${x}`))
  }
  if (pending.length) await mech('nothing else.', 'ledger-round', 'Review feedback')
  return result('done', { final_head: head, round: R, report, outcome, surfaced })
}

const saved = prior.match(/^Pre-flight result: (.*)$/m)
const pre = saved ? { ...JSON.parse(saved[1]), rulings: [], stop: false } : await ruler(`${/^Pre-flight/m.test(prior) ? `The pre-flight scan is already in the ledger ${ledgerFile}; don't redo it. From it and the plan, return` : `Run SDD's pre-flight scan as its Setup section describes: read the plan once, and the design. Append the scan table, then each ruling beside its row, to the ledger ${ledgerFile} under a line "Pre-flight:". Return`} the task count; the plan's Global Constraints copied verbatim (or the binding requirements from the design if the plan has none); and for each task, the implementer model per SDD's Model Selection (haiku when the task's text contains the complete code, sonnet for prose tasks and integration work, opus for design judgment or broad codebase understanding). Return only the rulings you made now.`,
  obj({ task_count: { type: 'integer' }, global_constraints: str, task_models: arr(obj({ task: { type: 'integer' }, model: { type: 'string', enum: TIERS } })), ...RULINGS }, ['task_count', 'global_constraints', 'task_models', 'rulings', 'stop']),
  'pre-flight', 'Setup')
rulings.push(...pre.rulings)
if (pre.stop) return await stop(pre.stop_reason, 'pre-flight')
if (!saved) note(`Pre-flight result: ${JSON.stringify({ task_count: pre.task_count, global_constraints: pre.global_constraints, task_models: pre.task_models })}`)
let lastHead = setup.head
const modelFor = n => (pre.task_models.find(t => t.task === n) || {}).model || 'sonnet'

// ---------- Tasks ----------
phase('Tasks')
const tasks = []
for (let n = 1; n <= pre.task_count; n++) {
  if (done.has(n)) continue
  const prep = await mech(`run ${SDD}'s task-brief script for task ${n} of ${A.planFile}. Put the brief path it prints in output, followed by a newline and the report path named after it the way SDD names report files (…-brief… becomes …-report…).`, `brief-${n}`, 'Tasks')
  if (!prep.ok) return await fail(`brief ${n}`, prep.output, 'Tasks')
  const [brief, report] = prep.output.trim().split('\n').map(s => s.trim())
  const base = prep.head, entry = { task: n, base, rounds: 0, parked: 0 }
  let model = modelFor(n)
  const context = `Task ${n} of ${pre.task_count} in ${A.planFile}.${carry.length ? ` Rulings from earlier tasks that bind this one:\n${carry.join('\n')}` : ''}`

  // 1-2. Dispatch the implementer and handle its report
  let impl, answer = ''
  for (let attempt = 1; ; attempt++) {
    impl = await ag(template('implementer', { 'task': n, 'brief file': brief, 'report file': report, 'directory': A.repo, 'context': context }) +
      ` ${LOCAL}${answer ? `\nThe controller's answer to your earlier report: ${answer}` : ''}`,
      { label: `implement-${n}${attempt > 1 ? `-a${attempt}` : ''}`, phase: 'Tasks', schema: IMPL, model, effort: effort(model) })
    if (impl.status === 'DONE' || impl.status === 'DONE_WITH_CONCERNS') break
    if (attempt === 3) return await stop(`task ${n}'s implementer still ${impl.status} after 3 dispatches: ${impl.details || impl.summary}`, `task ${n}`)
    const r = await ruler(`Task ${n}'s implementer (${model}) reported ${impl.status}: ${impl.details || impl.summary}\nBrief: ${brief}. Report: ${report}. Handle it as SDD's "Handle the report" says: give the missing context or your correction of the plan as answer, and set escalate if the task needs more reasoning than ${model} has.`,
      obj({ answer: str, escalate: bool, ...RULINGS }, ['answer', 'escalate', 'rulings', 'stop']), `rule-${n}-a${attempt}`, 'Tasks')
    if (r.stop) return await stop(r.stop_reason, `task ${n}`)
    rule(...r.rulings.map(x => `Task ${n}: ${x}`))
    if (r.escalate) model = up(model)
    answer = r.answer
  }
  let head = impl.head_sha
  const evidenceOnly = same(head, base)

  // 3. Review the task. A task with no commits (a spike, a measurement) gets its evidence reviewed instead.
  const reviewer = atLeast(model, 'sonnet')
  const review = await ag(template('task reviewer', { 'brief file': brief, 'report file': report, 'global constraints': pre.global_constraints, 'base': base, 'head': head, 'diff file': evidenceOnly ? 'none' : pkgOf(base, head) }) +
    `${evidenceOnly ? ' This task made no commits: there is no diff. Review the report file and the evidence files it names against the brief instead: were the required steps run, and do the recorded results support what the report claims? Read only.' : ''}${impl.status === 'DONE_WITH_CONCERNS' ? ` The implementer reported concerns; judge them with the rest: ${impl.details || impl.summary}` : ''} Ids T${n}-1…; put each "Cannot verify from diff" item in cannot_verify.`,
    { label: `review-${n}`, phase: 'Tasks', schema: REVIEW, model: reviewer, effort: effort(reviewer) })
  entry.review = `${review.spec_verdict}, ${review.quality_verdict}`
  let open = review.findings.filter(f => f.severity !== 'Minor')
  review.findings.filter(f => f.severity === 'Minor').forEach(f => { deferred.push(`T${n} ${f.id}: ${f.text}`); note(`Task ${n}: minor (deferred): ${f.id} ${f.text}`) })

  // Items the reviewer could not verify are checked against the code; findings the plan mandates are ruled on
  if (review.cannot_verify.length) {
    const c = await ag(`In ${A.repo}, task ${n} of the plan ${A.planFile} (brief ${brief}, commits ${base}..${head}). The task reviewer could not verify these requirements from the diff alone. Check each in the code, read only, and return each one that is a real gap, with file:line evidence; leave out the ones the code satisfies.\n${review.cannot_verify.join('\n')}`,
      { label: `verify-${n}`, phase: 'Tasks', model: 'sonnet', effort: 'medium', schema: obj({ gaps: arr(str) }) })
    open = open.concat(c.gaps.map((g, i) => ({ id: `T${n}-G${i + 1}`, severity: 'Important', text: g })))
  }
  const mandated = open.filter(f => f.plan_mandated)
  if (mandated.length) {
    const r = await ruler(`Task ${n} (brief ${brief}, commits ${base}..${head}). Rule on each plan-mandated finding against the plan text that mandates it; return in keep the ids that should go to the fix loop.\n${fmt(mandated)}`,
      obj({ keep: arr(str), ...RULINGS }, ['keep', 'rulings', 'stop']), `resolve-${n}`, 'Tasks')
    if (r.stop) return await stop(r.stop_reason, `task ${n}`)
    rule(...r.rulings.map(x => `Task ${n}: ${x}`))
    open = open.filter(f => !f.plan_mandated || r.keep.includes(f.id))
  }

  // 4. The fix loop: rounds 1-3 on the implementer's model, 4-5 a fresh implementer one tier up
  for (let round = 1; open.length && round <= CAP; round++) {
    const fixBase = head
    const fixModel = round <= 3 ? model : up(model)
    const fix = await ag(template('implementer', { 'task': n, 'brief file': brief, 'report file': report, 'directory': A.repo, 'context': context }) + ` ${LOCAL}
${round <= 3 ? `Fix round ${round} of ${CAP}: you already implemented this task; read the report file for what you did.` : `A prior implementer attempted this task ${round - 1} times; you own it now. Read the report file for what was tried.`} Fix these findings, re-run the tests that cover the amended code, append a fix report (covering tests, command, output) to the report file, and commit.
${fmt(open)}`,
      { label: `fix-${n}-r${round}`, phase: 'Tasks', schema: IMPL, model: fixModel, effort: effort(fixModel) })
    head = fix.head_sha
    const rrModel = 'sonnet'
    const rr = await ag(template('re-review', { 'brief file': brief, 'findings': fmt(open), 'report file': report, 'fix base': fixBase, 'head': head, 'diff file': pkgOf(fixBase, head) }) + ` ${fixRange(fixBase, head, base)} New finding ids T${n}-R${round}-1…; out-of-scope observations in out_of_scope.`,
      { label: `re-review-${n}-r${round}`, phase: 'Tasks', schema: REREVIEW, model: rrModel, effort: effort(rrModel) })
    const notAddressed = new Set(rr.results.filter(r => !r.addressed).map(r => r.id))
    const fresh = rr.new_findings.filter(f => f.severity !== 'Minor')
    rr.new_findings.filter(f => f.severity === 'Minor').map(f => `${f.id} ${f.text}`).concat(rr.out_of_scope).forEach(t => { deferred.push(`T${n} ${t}`); note(`Task ${n}: minor (deferred): ${t}`) })
    const before = open.length
    open = open.filter(f => notAddressed.has(f.id)).concat(fresh)
    note(`Task ${n}: fix round ${round}/${CAP} (${before - notAddressed.size} addressed, ${open.length} open; commits ${fixBase.slice(0, 7)}..${head.slice(0, 7)}${rr.rewrote_history ? ', history rewritten, reviewed from the task base' : ''})`)
    entry.rounds = round
  }

  // The breaker
  if (open.length) {
    const r = await ruler(`Task ${n}'s fix loop hit its cap of ${CAP} rounds (brief ${brief}, report ${report}, commits ${base}..${head}). Adjudicate each open finding as SDD's breaker says: park it (the reviewer is wrong or the point is contestable, or it is real but nothing downstream builds on it), or, if it is real and load-bearing, rule on the smallest change that unblocks the dependent work; that ruling is carried into later tasks.
${fmt(open)}`,
      obj({ decisions: arr(obj({ id: str, decision: { type: 'string', enum: ['park', 'carry'] }, ruling: str })), ...RULINGS }, ['decisions', 'rulings', 'stop']), `breaker-${n}`, 'Tasks')
    if (r.stop) return await stop(r.stop_reason, `task ${n}`)
    for (const d of r.decisions) {
      const f = open.find(x => x.id === d.id) || { id: d.id, text: '' }
      if (d.decision === 'park') { rule(`Task ${n}: parked — ${f.id} ${f.text} — ${d.ruling}`); parked.push(`T${n} ${f.id}: ${f.text} — ${d.ruling}`) }
      else { rule(`Task ${n}: ${d.ruling}`); carry.push(`Task ${n}: ${d.ruling}`) }
    }
    rule(...r.rulings.map(x => `Task ${n}: ${x}`))
    entry.parked = open.length
  }
  entry.review = evidenceOnly ? `evidence: ${entry.review}` : entry.review
  note(`Task ${n}: complete (${evidenceOnly && same(head, base) ? 'no commits, evidence reviewed' : `commits ${base.slice(0, 7)}..${head.slice(0, 7)}`}, ${entry.parked ? `${entry.parked} parked` : 'review clean'})`)
  lastHead = head
  tasks.push(entry)
  log(`Task ${n}: ${entry.rounds} fix round(s), ${entry.parked} parked`)
}

// ---------- Final review ----------
phase('Final review')
const final = await ag(template('code reviewer', { 'description': `the change implementing the plan ${A.planFile}`, 'plan or requirements': `the plan ${A.planFile} and the design ${A.designFile}`, 'base': A.baseSha, 'head': lastHead, 'review package': pkgOf(A.baseSha, lastHead) }, 'the superpowers:requesting-code-review skill') +
  ` Triage the deferred-minor and parked lines in the ledger ${ledgerFile}: set must_fix on any that must be fixed before merge (as a Minor finding if it isn't already one). Ids F-1…. Read only.`,
  { label: 'final-review', phase: 'Final review', model: 'opus', effort: 'high', schema: obj({ summary: str, ready: { type: 'string', enum: ['Yes', 'No', 'With fixes'] }, findings: arr(obj({ id: str, severity: SEV, must_fix: bool, text: str }, ['id', 'severity', 'text'])) }) })
let finalOpen = final.findings.filter(f => f.severity !== 'Minor' || f.must_fix)
final.findings.filter(f => f.severity === 'Minor' && !f.must_fix).forEach(f => { deferred.push(`final ${f.id}: ${f.text}`); note(`Final: minor (deferred): ${f.id} ${f.text}`) })
const surfaced = []
if (finalOpen.length) {
  const fixBase = lastHead, fixReport = `${A.repo}/.dev-work/final-fix-report.md`
  const fix = await ag(`In ${A.repo}: fix these findings from the whole-branch review of the plan ${A.planFile} (design ${A.designFile}) in one pass. Re-run the tests that cover what you change, write a fix report (what changed, covering tests, command, output) to ${fixReport}, and commit. ${LOCAL} Do not dispatch subagents.
${fmt(finalOpen)}`,
    { label: 'final-fix', phase: 'Final review', schema: IMPL, model: 'sonnet', effort: 'medium' })
  lastHead = fix.head_sha
  const rr = await ag(template('re-review', { 'brief file': A.planFile, 'findings': fmt(finalOpen), 'report file': fixReport, 'fix base': fixBase, 'head': fix.head_sha, 'diff file': pkgOf(fixBase, fix.head_sha) }) + ` ${fixRange(fixBase, fix.head_sha, A.baseSha)} New finding ids F-R-1…; out-of-scope observations in out_of_scope.`,
    { label: 'final-re-review', phase: 'Final review', schema: REREVIEW, model: 'sonnet', effort: 'medium' })
  const notAddressed = new Set(rr.results.filter(r => !r.addressed).map(r => r.id))
  rr.out_of_scope.forEach(t => { deferred.push(`final ${t}`); note(`Final: minor (deferred): ${t}`) })
  finalOpen = finalOpen.filter(f => notAddressed.has(f.id)).concat(rr.new_findings.filter(f => f.severity !== 'Minor'))
  if (finalOpen.length) {
    const r = await ruler(`The final whole-branch review's single fix wave left these findings open. There is no second wave. Adjudicate each as SDD's breaker says: park it, or, if it is real and load-bearing, rule on it; those are surfaced to the user at finishing.
${fmt(finalOpen)}`,
      obj({ decisions: arr(obj({ id: str, decision: { type: 'string', enum: ['park', 'surface'] }, ruling: str })), ...RULINGS }, ['decisions', 'rulings', 'stop']), 'final-breaker', 'Final review')
    if (r.stop) return await stop(r.stop_reason, 'final')
    for (const d of r.decisions) {
      const f = finalOpen.find(x => x.id === d.id) || { id: d.id, text: '' }
      if (d.decision === 'park') { rule(`Final: parked — ${f.id} ${f.text} — ${d.ruling}`); parked.push(`final ${f.id}: ${f.text} — ${d.ruling}`) }
      else { rule(`Final: ${d.ruling}`); surfaced.push(`${f.id}: ${f.text} — ${d.ruling}`) }
    }
    rule(...r.rulings.map(x => `Final: ${x}`))
  }
}

// Finish: the run's files stay in the worktree (.dev-work/ and SDD's workspace) until the worktree is removed
if (pending.length) await mech('nothing else.', 'ledger-final', 'Final review')
return result('done', { final_head: lastHead, final_review: final.summary, tasks, surfaced })
