export const meta = {
  name: 'review',
  description: 'dev-work: review the whole change locally, verify blockers, fix and re-review (cap 3 rounds), then draft the PR description',
  whenToUse: 'Started by a dev-work workflow skill.',
  phases: [{ title: 'Review' }, { title: 'Rounds' }, { title: 'Describe' }],
}

// args: { thread?, repo, runDir, designFile, planFile, baseSha, branch, title }
const A = args
const ag = (prompt, opts) => agent(A.thread ? `${prompt}\nThe ai-workspace thread "${A.thread}" holds this work's background and decisions; read it when it helps. It is private: nothing from it goes into anything that could be published (code, comments, docs, commit messages, PR text, replies) unless it stands on its own for a stranger. Never name the thread, its notes or ids, or the people in it.` : prompt, opts)
const CAP = 3
const BAR = `Classify each finding:
- blocker: a correctness bug, broken contract, security problem, data loss, changed behaviour without a test, duplicated logic, a swallowed error or a test that asserts nothing, AND you can state the concrete failure (input or state, and the wrong outcome). Never for pre-existing problems.
- follow-up: matters, but is out of scope or would bloat the change (including pre-existing problems).
- nitpick: everything else. Design judgements (abstractions, cohesion, naming taste) are never blockers.
Report everything in one pass, with no limit. Give a path and line where possible.`

const str = { type: 'string' }
const obj = (props, req = Object.keys(props)) => ({ type: 'object', properties: props, required: req })
const arr = items => ({ type: 'array', items })
const FINDING = obj({ id: str, kind: { type: 'string', enum: ['blocker', 'follow-up', 'nitpick'] }, path: str, line: { type: 'integer' }, text: str, failure: str }, ['id', 'kind', 'text'])
const where = f => (f.path ? ` at ${f.path}:${f.line || ''}` : '')
const describe = f => `${f.id} (${f.kind}): ${f.text}${f.failure ? ` — failure: ${f.failure}` : ''}${where(f)}`

const verify = async (blockers, label, ph) => blockers.length ? (await ag(`Try to disprove each blocker on the code in ${A.repo} (read only; running tests is fine). Refute only with concrete evidence (a cited file:line, or a test run); "can't confirm" is not a refutation.\n${blockers.map(describe).join('\n')}`,
  { label, phase: ph, model: 'opus', effort: 'high', schema: obj({ results: arr(obj({ id: str, refuted: { type: 'boolean' }, evidence: str })) }) })).results.filter(r => r.refuted) : []

// ---------- Review ----------
phase('Review')
const ledger = {}
const first = await ag(`Follow the code reviewer prompt from the superpowers:requesting-code-review skill for the change ${A.baseSha}..HEAD in ${A.repo}: description ${JSON.stringify(A.title)}; requirements in the design ${A.designFile} and the plan ${A.planFile}. Check the whole change against the design, and read beyond the diff where a concrete risk calls for it. Read only.
${BAR}
Ids R1-1…; give a one-paragraph verdict as summary.`,
  { label: 'first-review', phase: 'Review', model: 'opus', effort: 'high', schema: obj({ summary: str, findings: arr(FINDING) }) })
first.findings.forEach(f => { ledger[f.id] = { ...f, state: f.kind === 'blocker' ? 'open' : f.kind } })
for (const r of await verify(first.findings.filter(f => f.kind === 'blocker'), 'verify-r1', 'Review')) Object.assign(ledger[r.id], { state: 'refuted', refutation: r.evidence })

// ---------- Rounds ----------
phase('Rounds')
const openBlockers = () => Object.values(ledger).filter(f => f.kind === 'blocker' && f.state === 'open')
const rounds = []
let sentOthers = false, lastSummary = first.summary
for (let round = 2; openBlockers().length && round <= CAP + 1; round++) {
  const targets = openBlockers().concat(sentOthers ? [] : Object.values(ledger).filter(f => f.state === 'follow-up' || f.state === 'nitpick'))
  sentOthers = true
  const fix = await ag(`Use the superpowers:receiving-code-review skill on ${A.branch} in ${A.repo} (design ${A.designFile}, plan ${A.planFile}). Commit locally; don't push. Nobody will answer questions.
For each finding: blocker → fix it ("fixed", with the commit sha) or dispute it with concrete evidence ("disputed"; a stated reason is not evidence); nitpick → "fixed" or "dropped" with a short reason; follow-up → "follow-up", one line on why it waits. Run the tests. Report the HEAD sha before and after your commits.
${targets.map(describe).join('\n')}`,
    { label: `fix-r${round}`, phase: 'Rounds', model: round <= 2 ? 'sonnet' : 'opus', effort: round <= 2 ? 'medium' : 'high',
      schema: obj({ head_before: str, head_after: str, replies: arr(obj({ id: str, status: { type: 'string', enum: ['fixed', 'disputed', 'dropped', 'follow-up'] }, sha: str, text: str }, ['id', 'status', 'text'])) }) })
  fix.replies.forEach(r => { if (ledger[r.id] && ledger[r.id].kind !== 'blocker') ledger[r.id].state = r.status; if (ledger[r.id]) ledger[r.id].reply = `${r.status}: ${r.text}` })

  const rr = await ag(`Narrow re-review in ${A.repo} (read only):
1. For each open blocker, is it addressed in ${fix.head_before}..${fix.head_after}? "Attempted" is not addressed; a dispute counts only if its evidence concretely refutes the blocker.
2. New blockers introduced by that delta only; nothing about unchanged code, no follow-ups or nitpicks.
${BAR}
${openBlockers().map(f => `${describe(f)}\n  reply: ${f.reply || 'none'}`).join('\n')}
New ids R${round}-1…; one-paragraph verdict as summary.`,
    { label: `re-review-r${round}`, phase: 'Rounds', model: 'opus', effort: 'medium',
      schema: obj({ summary: str, results: arr(obj({ id: str, addressed: { type: 'boolean' } })), new_findings: arr(FINDING) }) })
  rr.results.forEach(r => { if (ledger[r.id] && r.addressed) ledger[r.id].state = 'fixed' })
  const fresh = rr.new_findings.filter(f => f.kind === 'blocker')
  const refuted = await verify(fresh, `verify-r${round}`, 'Rounds')
  fresh.forEach(f => { ledger[f.id] = { ...f, state: refuted.find(r => r.id === f.id) ? 'refuted' : 'open' } })
  lastSummary = rr.summary
  rounds.push({ round, addressed: rr.results.filter(r => r.addressed).map(r => r.id), new_blockers: fresh.map(f => f.id), refuted: refuted.map(r => r.id) })
}

const all = Object.values(ledger)
const status = openBlockers().length ? 'blocked_at_cap' : 'ready'
const result = {
  status, summary: lastSummary, rounds,
  open_blockers: openBlockers().map(describe),
  follow_ups: all.filter(f => f.state === 'follow-up').map(describe),
  refuted: all.filter(f => f.state === 'refuted').map(f => `${f.id}: ${f.refutation}`),
  ledger: all.map(f => ({ id: f.id, kind: f.kind, state: f.state, text: f.text })),
}
if (status !== 'ready') return result

// ---------- Describe ----------
phase('Describe')
const bodyFile = `${A.runDir}/pr-body.md`
await ag(`Write a pull request description for ${A.baseSha}..HEAD in ${A.repo} to ${bodyFile}, from the design ${A.designFile} and the plan ${A.planFile}. Use the repository's PR template if it has one (never tick an undone checkbox); otherwise Summary, Changes, Testing, Review. Under Review, summarise the automated review in a few lines: ${rounds.length} fix round(s); blockers fixed: ${all.filter(f => f.kind === 'blocker' && f.state === 'fixed').length}; refuted: ${result.refuted.length}; follow-ups: ${result.follow_ups.length}. Write for strangers: no mention of designs, plans, runs or any internal process. Write only the file.`,
  { label: 'pr-body', phase: 'Describe', model: 'sonnet', effort: 'medium' })
return { ...result, pr_body_file: bodyFile }
