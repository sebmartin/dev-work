export const meta = {
  name: 'pr-review',
  description: 'dev-work: open the PR behind a privacy gate, then review, verify, fix and re-review on GitHub (cap 3 rounds)',
  whenToUse: 'Started by a dev-work workflow skill.',
  phases: [{ title: 'Open' }, { title: 'Review' }, { title: 'Rounds' }],
}

// args: { repo, runDir, planFile, scopeFile, baseSha, branch, baseBranch, repoSlug, title, publicContext, prNumber? }
const A = args
const CAP = 3
const BAR = `Classify each finding:
- blocker: a correctness bug, broken contract, security problem, data loss, changed behaviour without a test, duplicated logic, a swallowed error or a test that asserts nothing, AND you can state the concrete failure (input or state, and the wrong outcome). Never for pre-existing problems.
- follow-up: matters, but is out of scope or would bloat the PR (including pre-existing problems).
- nitpick: everything else. Design judgements (abstractions, cohesion, naming taste) are never blockers.
Report everything in one pass, with no limit. Give a path and diff line where possible.`

const str = { type: 'string' }
const obj = (props, req = Object.keys(props)) => ({ type: 'object', properties: props, required: req })
const arr = items => ({ type: 'array', items })
const MECH = obj({ ok: { type: 'boolean' }, output: str })
const TEXTS = obj({ texts: arr(obj({ id: str, text: str })) })
const FINDING = obj({ id: str, kind: { type: 'string', enum: ['blocker', 'follow-up', 'nitpick'] }, path: str, line: { type: 'integer' }, text: str, failure: str }, ['id', 'kind', 'text'])
const POSTED = obj({ ok: { type: 'boolean' }, output: str, comments: arr(obj({ id: str, url: str, comment_id: { type: 'integer' } }, ['id'])) }, ['ok'])

const mech = (task, label, ph) => agent(`In ${A.repo}, on ${A.repoSlug}: ${task} Do only this; report success and the output.`,
  { label, phase: ph, schema: MECH, model: 'sonnet', effort: 'low' })
const where = f => (f.path ? ` at ${f.path}:${f.line || ''}` : '')
const describe = f => `${f.id} (${f.kind}): ${f.text}${f.failure ? ` — failure: ${f.failure}` : ''}${where(f)}`
const body = f => `**${f.id} · ${f.kind}**\n\n${f.text}${f.failure ? `\n\nFailure: ${f.failure}` : ''}`

// Privacy gate. Fails closed: returns the flagged items, or null when everything is cleared.
const gate = async (items, label, ph) => {
  if (!items.length) return null
  const r = await agent(`Privacy gate for text about to be posted publicly on GitHub. You don't know the author's private context, and that's the point: flag any text referring to something a stranger with only the public context below couldn't resolve or verify (a person, a conversation, an internal decision or rule, a project, team or client, an event, an earlier agreement, a notes system, or an ungrounded specific fact). General knowledge, public standards, and anything grounded in the repository, ticket or PR are fine. When unsure, flag.

PUBLIC CONTEXT: ${A.publicContext}
Repository: ${A.repoSlug} (code at ${A.repo}; read only).

TEXTS:
${items.map(i => `${i.id}:\n${i.text}`).join('\n\n')}`,
    { label, phase: ph, model: 'opus', effort: 'high', schema: obj({ results: arr(obj({ id: str, flagged: { type: 'boolean' }, reason: str })) }) })
  const cleared = new Set(r.results.filter(x => !x.flagged).map(x => x.id))
  const flagged = items.filter(i => !cleared.has(i.id)).map(i => r.results.find(x => x.id === i.id) || { id: i.id, reason: 'not checked' })
  return flagged.length ? flagged : null
}
const commits = (from, to, label, ph) => agent(`In ${A.repo}, return every commit in ${from}..${to} as {id: short sha, text: full message}.`,
  { label, phase: ph, schema: TEXTS, model: 'haiku', effort: 'low' })
const verify = async (blockers, label, ph) => blockers.length ? (await agent(`Try to disprove each blocker on the code in ${A.repo} (HEAD; read only, tests allowed). Refute only with concrete evidence (a cited file:line, or a test run); "can't confirm" is not a refutation.\n${blockers.map(describe).join('\n')}`,
  { label, phase: ph, model: 'opus', effort: 'high', schema: obj({ results: arr(obj({ id: str, refuted: { type: 'boolean' }, evidence: str })) }) })).results.filter(r => r.refuted) : []
const post = async (summary, findings, label, ph) => {
  const flagged = await gate([{ id: 'summary', text: summary }, ...findings.map(f => ({ id: f.id, text: body(f) }))], `privacy-${label}`, ph)
  if (flagged) return { blocked: flagged }
  return agent(`Post one COMMENT review (never approve or request changes) on ${A.repoSlug} PR #${prNumber}: the summary as the body, each finding as an inline comment on its line where the line is in the diff, otherwise appended to the body. Post the texts exactly. Report the review URL and, per finding id, its comment URL and numeric comment id.
SUMMARY:\n${summary}\nFINDINGS (JSON):\n${JSON.stringify(findings.map(f => ({ id: f.id, path: f.path || null, line: f.line || null, body: body(f) })))}`,
    { label, phase: ph, schema: POSTED, model: 'sonnet', effort: 'medium' })
}

// ---------- Open ----------
phase('Open')
let prNumber = A.prNumber || null, prUrl = null
if (!prNumber) {
  const bodyFile = `${A.runDir}/pr-body.md`
  await agent(`Write a PR description for ${A.baseSha}..HEAD in ${A.repo} to ${bodyFile}, from the scope ${A.scopeFile} and the plan ${A.planFile}. Use the repository's PR template if it has one (never tick an undone checkbox); otherwise Summary, Changes, Testing, Assumptions, Review status. Write for strangers: no mention of plans, runs or internal process.`,
    { label: 'pr-body', phase: 'Open', model: 'sonnet', effort: 'medium' })
  const cs = await commits(A.baseSha, 'HEAD', 'commit-messages', 'Open')
  const bt = await agent(`Return the contents of ${bodyFile} as {texts:[{id:"pr-body", text}]}.`, { label: 'read-body', phase: 'Open', schema: TEXTS, model: 'haiku', effort: 'low' })
  const flagged = await gate([...cs.texts.map(c => ({ id: `commit ${c.id}`, text: c.text })), ...bt.texts, { id: 'pr-title', text: A.title }], 'privacy-open', 'Open')
  if (flagged) return { status: 'privacy_blocked', stage: 'open', flagged }
  const opened = await mech(`push ${A.branch} to origin, then open a PR from it into ${A.baseBranch} titled ${JSON.stringify(A.title)} with the body in ${bodyFile} (or reuse an existing PR for this branch). Report "PR <number> <url>".`, 'open-pr', 'Open')
  const m = opened.ok && opened.output.match(/PR\s+#?(\d+)\s+(\S+)/)
  if (!m) return { status: 'failed', stage: 'open', detail: opened.output }
  prNumber = Number(m[1]); prUrl = m[2]
}

// ---------- Review ----------
phase('Review')
const ledger = {}
const first = await agent(`Follow the code reviewer prompt from the superpowers:requesting-code-review skill for ${A.repo}: description ${JSON.stringify(A.title)}; requirements in ${A.scopeFile} and ${A.planFile}; base ${A.baseSha}; head HEAD. Check the whole change against the scope, and read beyond the diff where a concrete risk calls for it. Read only.
${BAR}
Ids R1-1…; give a one-paragraph verdict as summary.`,
  { label: 'first-review', phase: 'Review', model: 'opus', effort: 'xhigh', schema: obj({ summary: str, findings: arr(FINDING) }) })
first.findings.forEach(f => { ledger[f.id] = { ...f, state: f.kind === 'blocker' ? 'open' : f.kind } })
for (const r of await verify(first.findings.filter(f => f.kind === 'blocker'), 'verify-r1', 'Review')) Object.assign(ledger[r.id], { state: 'refuted', refutation: r.evidence })
const p1 = await post(first.summary, first.findings.filter(f => ledger[f.id].state !== 'refuted'), 'post-r1', 'Review')
if (p1.blocked) return { status: 'privacy_blocked', stage: 'first review', flagged: p1.blocked, pr_number: prNumber }
if (!p1.ok) return { status: 'failed', stage: 'post first review', detail: p1.output, pr_number: prNumber }
;(p1.comments || []).forEach(c => ledger[c.id] && Object.assign(ledger[c.id], { url: c.url, comment_id: c.comment_id }))

// ---------- Rounds ----------
phase('Rounds')
const openBlockers = () => Object.values(ledger).filter(f => f.kind === 'blocker' && f.state === 'open')
const rounds = []
let sentOthers = false
for (let round = 2; openBlockers().length && round <= CAP + 1; round++) {
  const fixBase = (await mech('report the HEAD sha.', `head-r${round}`, 'Rounds')).output.trim().split(/\s+/).pop()
  const targets = openBlockers().concat(sentOthers ? [] : Object.values(ledger).filter(f => f.state === 'follow-up' || f.state === 'nitpick'))
  sentOthers = true
  const fix = await agent(`Use the superpowers:receiving-code-review skill on ${A.branch} in ${A.repo} (scope ${A.scopeFile}, plan ${A.planFile}). Commit locally; don't push. Nobody will answer questions.
For each finding: blocker → fix it ("fixed", with sha) or dispute it with concrete evidence ("disputed"; a stated reason is not evidence); nitpick → "fixed" or "dropped" with a short reason; follow-up → "follow-up", one line on why it waits. Run the tests. Replies are posted publicly as written: address a stranger reading the PR.
${targets.map(describe).join('\n')}`,
    { label: `fix-r${round}`, phase: 'Rounds', model: round <= 3 ? 'sonnet' : 'opus', effort: round <= 3 ? 'medium' : 'high',
      schema: obj({ head_sha: str, replies: arr(obj({ id: str, status: { type: 'string', enum: ['fixed', 'disputed', 'dropped', 'follow-up'] }, sha: str, text: str }, ['id', 'status', 'text'])) }) })
  const cs = await commits(fixBase, fix.head_sha, `commit-messages-r${round}`, 'Rounds')
  const flagged = await gate([...cs.texts.map(c => ({ id: `commit ${c.id}`, text: c.text })), ...fix.replies.map(r => ({ id: `reply ${r.id}`, text: r.text }))], `privacy-fix-r${round}`, 'Rounds')
  if (flagged) return { status: 'privacy_blocked', stage: `fix round ${round}`, flagged, pr_number: prNumber, ledger: Object.values(ledger) }
  const replies = fix.replies.map(r => ({ comment_id: ledger[r.id] && ledger[r.id].comment_id, id: r.id, body: `${r.status}${r.sha ? ` in ${r.sha}` : ''}: ${r.text}` }))
  const pushed = await mech(`push ${A.branch}, then post these replies on PR #${prNumber}: as a reply to the review comment where comment_id is set, otherwise together in one PR comment, each prefixed with its id. Post the bodies exactly.\n${JSON.stringify(replies)}`, `push-reply-r${round}`, 'Rounds')
  if (!pushed.ok) return { status: 'failed', stage: `push and reply, round ${round}`, detail: pushed.output, pr_number: prNumber, ledger: Object.values(ledger) }
  fix.replies.forEach(r => { if (ledger[r.id] && ledger[r.id].kind !== 'blocker') ledger[r.id].state = r.status })

  const rr = await agent(`Narrow re-review in ${A.repo} (read only):
1. For each open blocker, is it addressed in ${fixBase}..${fix.head_sha}? "Attempted" is not addressed; a dispute counts only if its evidence concretely refutes the blocker.
2. New blockers introduced by that delta only; nothing about unchanged code, no follow-ups or nitpicks.
${BAR}
${openBlockers().map(f => { const r = fix.replies.find(x => x.id === f.id) || {}; return `${describe(f)}\n  reply: ${r.status || 'none'}: ${r.text || ''}` }).join('\n')}
New ids R${round}-1…; one-paragraph verdict as summary.`,
    { label: `re-review-r${round}`, phase: 'Rounds', model: 'opus', effort: 'medium',
      schema: obj({ summary: str, results: arr(obj({ id: str, addressed: { type: 'boolean' } })), new_findings: arr(FINDING) }) })
  rr.results.forEach(r => { if (ledger[r.id] && r.addressed) ledger[r.id].state = 'fixed' })
  const fresh = rr.new_findings.filter(f => f.kind === 'blocker')
  const refuted = await verify(fresh, `verify-r${round}`, 'Rounds')
  fresh.forEach(f => { ledger[f.id] = { ...f, state: refuted.find(r => r.id === f.id) ? 'refuted' : 'open' } })
  const p = await post(rr.summary, fresh.filter(f => ledger[f.id].state === 'open'), `post-r${round}`, 'Rounds')
  if (p.blocked) return { status: 'privacy_blocked', stage: `re-review round ${round}`, flagged: p.blocked, pr_number: prNumber, ledger: Object.values(ledger) }
  ;(p.comments || []).forEach(c => ledger[c.id] && Object.assign(ledger[c.id], { url: c.url, comment_id: c.comment_id }))
  const resolve = rr.results.filter(r => r.addressed && ledger[r.id] && ledger[r.id].comment_id).map(r => ledger[r.id].comment_id)
  if (resolve.length) await mech(`resolve the review threads on PR #${prNumber} that start with comment ids ${resolve.join(', ')}.`, `resolve-r${round}`, 'Rounds')
  rounds.push({ round, addressed: rr.results.filter(r => r.addressed).map(r => r.id), new_blockers: fresh.map(f => f.id), refuted: refuted.map(r => r.id) })
}

const all = Object.values(ledger)
return {
  status: openBlockers().length ? 'blocked_at_cap' : 'ready',
  pr_number: prNumber, pr_url: prUrl,
  open_blockers: openBlockers(),
  follow_ups: all.filter(f => f.state === 'follow-up'),
  refuted: all.filter(f => f.state === 'refuted').map(f => ({ id: f.id, evidence: f.refutation })),
  rounds,
  ledger: all.map(f => ({ id: f.id, kind: f.kind, state: f.state, url: f.url || null })),
}
