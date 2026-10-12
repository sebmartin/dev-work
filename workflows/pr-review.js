export const meta = {
  name: 'pr-review',
  description: 'dev-work: open the PR behind a privacy gate, then review, verify, fix and re-review on GitHub (cap 3 rounds)',
  whenToUse: 'Started by the dev-work:develop skill; not meant to be run by hand.',
  phases: [
    { title: 'Open', detail: 'PR body, privacy gate, push, create PR' },
    { title: 'Review', detail: 'first review, verify blockers, post' },
    { title: 'Rounds', detail: 'fix, gate, push and reply, re-review, verify, post' },
  ],
}

// args: { repo, runDir, planFile, scopeFile, spDir, baseSha, branch, baseBranch, repoSlug, title, publicContext, prNumber? }
//   spDir: the Superpowers skills directory; publicContext: what a stranger can see (ticket text if public, else the scope statement)
const A = args
const CAP = 3
const BAR = `Classify every finding:
- "blocker" only if it is one of: a correctness bug, a broken contract or interface, a security problem, data loss, changed behaviour without a test, duplicated logic, a swallowed error, or a test that asserts nothing, AND you can state a concrete failure (the input or state, and the wrong outcome). Pre-existing problems the change does not make worse are never blockers.
- "follow-up" if it matters but is outside the scope or would bloat this PR, including pre-existing problems.
- "nitpick" for everything else. Design judgements (abstraction quality, cohesion, coupling, naming taste) are follow-ups or nitpicks, never blockers.
Report everything you find in this one pass; there is no limit on the number of findings. Give a path and a line in the diff for each finding where possible.`

const MECH = { type: 'object', properties: { ok: { type: 'boolean' }, output: { type: 'string' } }, required: ['ok', 'output'] }
const TEXTS = { type: 'object', properties: { texts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } } }, required: ['texts'] }
const GATE = { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: {
  id: { type: 'string' }, flagged: { type: 'boolean' }, reason: { type: 'string' } }, required: ['id', 'flagged', 'reason'] } } }, required: ['results'] }
const FINDINGS = { type: 'object', properties: {
  summary: { type: 'string' },
  findings: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, kind: { type: 'string', enum: ['blocker', 'follow-up', 'nitpick'] },
    path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' }, failure: { type: 'string' } },
    required: ['id', 'kind', 'text'] } } }, required: ['summary', 'findings'] }
const VERIFY = { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: {
  id: { type: 'string' }, refuted: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['id', 'refuted', 'evidence'] } } }, required: ['results'] }
const POSTED = { type: 'object', properties: { ok: { type: 'boolean' }, review_url: { type: 'string' }, output: { type: 'string' },
  comments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string' }, comment_id: { type: 'integer' } }, required: ['id'] } } },
  required: ['ok'] }
const FIX = { type: 'object', properties: { head_sha: { type: 'string' },
  replies: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'disputed', 'dropped', 'follow-up'] }, sha: { type: 'string' }, text: { type: 'string' } },
    required: ['id', 'status', 'text'] } } }, required: ['head_sha', 'replies'] }
const RER = { type: 'object', properties: {
  summary: { type: 'string' },
  results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, addressed: { type: 'boolean' }, reason: { type: 'string' } }, required: ['id', 'addressed'] } },
  new_findings: FINDINGS.properties.findings }, required: ['summary', 'results', 'new_findings'] }

const mech = (task, label, ph) => agent(`${task}\nWork in ${A.repo}. Use gh for GitHub and always pass --repo ${A.repoSlug} where the command accepts it. Do exactly this and nothing else. Report whether it succeeded and the relevant output (URLs, numbers, errors).`,
  { label, phase: ph, schema: MECH, model: 'sonnet', effort: 'low' })

// Privacy gate: fails closed. Returns null if everything is clean, else the flagged items.
const gate = async (items, label, ph) => {
  if (!items.length) return null
  const r = await agent(`You are a privacy gate for text about to be posted publicly to GitHub (commit messages, a PR body, review comments, replies).
You do not know the author's private context, and that is the point: flag any text that refers to something a stranger who has ONLY the public context below could not resolve or verify. Typical examples: a person, a meeting or conversation, an internal decision, rule or document, a project, team, client or partner, an organisational or personal event, an earlier agreement, a workspace or note-taking system, or a specific fact (a number, a constraint, a track record) that is asserted but not grounded in the public context. General programming knowledge, public standards, and anything grounded in the repository, the ticket or the pull request (its commits, issues and review) are fine. When unsure, flag: a false alarm is much cheaper than a leak.

PUBLIC CONTEXT
${A.publicContext}
Repository: ${A.repoSlug} (you may read the code at ${A.repo}; do not modify anything).

TEXTS TO CHECK
${items.map(i => `${i.id}:\n${i.text}`).join('\n\n')}

Return one result per id.`, { label, phase: ph, schema: GATE, model: 'opus', effort: 'high' })
  const flagged = r.results.filter(x => x.flagged)
  // fail closed: anything not explicitly cleared counts as flagged
  const cleared = new Set(r.results.filter(x => !x.flagged).map(x => x.id))
  const missing = items.filter(i => !cleared.has(i.id) && !flagged.find(f => f.id === i.id)).map(i => ({ id: i.id, flagged: true, reason: 'not checked' }))
  return flagged.length || missing.length ? flagged.concat(missing) : null
}
const commitTexts = (from, to, label, ph) => agent(`In ${A.repo}, list every commit in ${from}..${to} with its full message (\`git log --format='%H%n%B%n--END--' ${from}..${to}\`). Return each as {id: the short sha, text: the full message}. Do nothing else.`,
  { label, phase: ph, schema: TEXTS, model: 'haiku', effort: 'low' })
const blocked = (stage, flagged, extra = {}) => ({ status: 'privacy_blocked', stage, flagged, ...extra })
const fmt = f => `**${f.id} · ${f.kind}**\n\n${f.text}${f.failure ? `\n\nFailure: ${f.failure}` : ''}`

// ---------- Open ----------
phase('Open')
let prNumber = A.prNumber || null, prUrl = null
if (!prNumber) {
  const bodyFile = `${A.runDir}/pr-body.md`
  await agent(`Write a pull request description to ${bodyFile} for the branch ${A.branch} in ${A.repo} (changes ${A.baseSha}..HEAD).
If the repository has a pull request template (.github/pull_request_template.md, .github/PULL_REQUEST_TEMPLATE.md, PULL_REQUEST_TEMPLATE.md or docs/pull_request_template.md), fill in its sections and never tick a checkbox for something not done. Otherwise use the sections Summary, Changes, Testing, Assumptions and Review status ("Automated review in progress.").
Base it on the scope in ${A.scopeFile} and the plan in ${A.planFile}. It is read by strangers: describe the change and its reasons on their own terms, and do not mention plans, briefs, pipelines, runs, notes or any internal process. Write only the file.`,
    { label: 'pr-body', phase: 'Open', model: 'sonnet', effort: 'medium' })
  const commits = await commitTexts(A.baseSha, 'HEAD', 'commit-messages', 'Open')
  const body = await agent(`Return the full contents of ${bodyFile} as {texts:[{id:"pr-body", text:<contents>}]}, and also {id:"pr-title", text:${JSON.stringify(A.title)}}. Do nothing else.`,
    { label: 'read-body', phase: 'Open', schema: TEXTS, model: 'haiku', effort: 'low' })
  const flagged = await gate([...commits.texts.map(c => ({ id: `commit ${c.id}`, text: c.text })), ...body.texts], 'privacy-open', 'Open')
  if (flagged) return blocked('open', flagged)
  const opened = await mech(`Push the branch ${A.branch} to origin (git push -u origin ${A.branch}). If a pull request for this branch already exists on ${A.repoSlug}, report its number and URL. Otherwise create one: gh pr create --repo ${A.repoSlug} --base ${A.baseBranch} --head ${A.branch} --title ${JSON.stringify(A.title)} --body-file ${bodyFile}. Report the PR number and URL as "PR <number> <url>".`, 'open-pr', 'Open')
  if (!opened.ok) return { status: 'failed', stage: 'open', detail: opened.output }
  const m = opened.output.match(/PR\s+#?(\d+)\s+(\S+)/)
  prNumber = m ? Number(m[1]) : null
  prUrl = m ? m[2] : opened.output
  if (!prNumber) return { status: 'failed', stage: 'open', detail: `could not read the PR number: ${opened.output}` }
}

// ---------- Review ----------
phase('Review')
const ledger = {}  // id -> { ...finding, state: open|fixed|dropped|follow-up|refuted, url, comment_id }
const first = await agent(`Read the prompt template ${A.spDir}/requesting-code-review/code-reviewer.md. Act as the reviewer it describes, following the prompt inside its code block with:
- [DESCRIPTION] = ${A.title}
- [PLAN_OR_REQUIREMENTS] = the scope in ${A.scopeFile} and the plan in ${A.planFile}
- [BASE_SHA] = ${A.baseSha}
- [HEAD_SHA] = the current HEAD of ${A.repo}
Review the whole change in ${A.repo}, reading beyond the diff where a concrete risk calls for it (callers of changed code, tests that cover it). Check the whole change against the scope, not only each part. Do not modify the repository.
${BAR}
Give findings ids R1-1, R1-2…. In "summary", give a one-paragraph verdict.`,
  { label: 'first-review', phase: 'Review', schema: FINDINGS, model: 'opus', effort: 'xhigh' })

const verify = async (blockers, label, ph) => {
  if (!blockers.length) return []
  const v = await agent(`Try to disprove each of these review blockers on the code in ${A.repo} (HEAD). You may read code and run the tests; do not modify the repository.
A blocker is refuted only by concrete evidence: a cited file:line showing it can't happen, or a test run showing correct behaviour. "I could not confirm it" does not refute it.
${blockers.map(f => `${f.id}: ${f.text}${f.failure ? ` (failure: ${f.failure})` : ''}${f.path ? ` at ${f.path}:${f.line || ''}` : ''}`).join('\n')}`,
    { label, phase: ph, schema: VERIFY, model: 'opus', effort: 'high' })
  return v.results.filter(r => r.refuted)
}
const post = async (summary, findings, label, ph) => {
  const items = [{ id: 'review-summary', text: summary }, ...findings.map(f => ({ id: f.id, text: fmt(f) }))]
  const flagged = await gate(items, `privacy-${label}`, ph)
  if (flagged) return { blocked: flagged }
  const posted = await agent(`Post one pull request review on ${A.repoSlug} PR #${prNumber} with event COMMENT (never APPROVE or REQUEST_CHANGES), using gh api (POST /repos/${A.repoSlug}/pulls/${prNumber}/reviews).
Review body: the summary below, followed by any findings that cannot be inline comments.
Each finding with a path and line goes as an inline comment on that line (side RIGHT), with exactly the body given. If GitHub rejects a line because it is not in the diff, move that finding into the review body instead.
Afterwards, fetch the review's comments and report, for each finding id, its comment URL and numeric comment id (findings in the body get the review's URL and no comment id). Report the review URL.
Post the texts exactly as given; do not add or change words.

SUMMARY:
${summary}

FINDINGS (JSON):
${JSON.stringify(findings.map(f => ({ id: f.id, path: f.path || null, line: f.line || null, body: fmt(f) })))}`,
    { label, phase: ph, schema: POSTED, model: 'sonnet', effort: 'medium' })
  return posted
}

const refuted1 = await verify(first.findings.filter(f => f.kind === 'blocker'), 'verify-r1', 'Review')
first.findings.forEach(f => { ledger[f.id] = { ...f, state: f.kind === 'blocker' ? 'open' : f.kind } })
refuted1.forEach(r => { ledger[r.id].state = 'refuted'; ledger[r.id].refutation = r.evidence })
const toPost1 = first.findings.filter(f => ledger[f.id].state !== 'refuted')
const p1 = await post(first.summary, toPost1, 'post-r1', 'Review')
if (p1.blocked) return blocked('first review', p1.blocked, { pr_number: prNumber })
if (!p1.ok) return { status: 'failed', stage: 'post first review', detail: p1.output, pr_number: prNumber }
;(p1.comments || []).forEach(c => { if (ledger[c.id]) Object.assign(ledger[c.id], { url: c.url, comment_id: c.comment_id }) })

// ---------- Rounds ----------
phase('Rounds')
const rounds = []
let round = 1
const openBlockers = () => Object.values(ledger).filter(f => f.kind === 'blocker' && f.state === 'open')
let nonBlockersSent = false
while (openBlockers().length && round <= CAP) {
  round++
  const fixBase = await agent(`Report HEAD of ${A.repo}: run git -C ${A.repo} rev-parse HEAD and return {ok:true, output:<sha>}.`, { label: `head-r${round}`, phase: 'Rounds', schema: MECH, model: 'haiku', effort: 'low' })
  const targets = openBlockers().concat(nonBlockersSent ? [] : Object.values(ledger).filter(f => f.state === 'follow-up' || f.state === 'nitpick'))
  nonBlockersSent = true
  const fix = await agent(`Use the superpowers:receiving-code-review skill. You are addressing review findings on branch ${A.branch} in ${A.repo}. Scope: ${A.scopeFile}. Plan: ${A.planFile}.
You are running unattended: nobody will answer questions. Commit locally; do not push or touch any remote.
For each finding decide:
- blocker: fix it (status "fixed", with the commit sha), or dispute it with concrete evidence (status "disputed": a cited file:line, or a test and its output; a stated preference or reason is not evidence).
- nitpick: fix it ("fixed") or drop it ("dropped", one short reason).
- follow-up: do not fix; acknowledge it ("follow-up", one line on why it belongs in a later change).
Run the test suite after your fixes. Each reply is posted publicly as is: write it for a stranger reading the PR, and refer only to the code, the PR and its review.
Findings:
${targets.map(f => `${f.id} (${f.kind}): ${f.text}${f.failure ? ` (failure: ${f.failure})` : ''}${f.path ? ` at ${f.path}:${f.line || ''}` : ''}`).join('\n')}
Return HEAD after your commits and one reply per finding id.`,
    { label: `fix-r${round}`, phase: 'Rounds', schema: FIX, model: round <= 2 ? 'sonnet' : 'opus', effort: round <= 2 ? 'medium' : 'high' })
  const commits = await commitTexts(fixBase.output.trim(), fix.head_sha, `commit-messages-r${round}`, 'Rounds')
  const flagged = await gate([...commits.texts.map(c => ({ id: `commit ${c.id}`, text: c.text })), ...fix.replies.map(r => ({ id: `reply ${r.id}`, text: r.text }))], `privacy-fix-r${round}`, 'Rounds')
  if (flagged) return blocked(`fix round ${round}`, flagged, { pr_number: prNumber, ledger: Object.values(ledger) })
  const replyPlan = fix.replies.map(r => ({ comment_id: ledger[r.id] && ledger[r.id].comment_id, id: r.id, body: `${r.status}${r.sha ? ` in ${r.sha}` : ''}: ${r.text}` }))
  const pushed = await mech(`Push branch ${A.branch} (git push origin ${A.branch}). Then post these replies on PR #${prNumber}: where comment_id is set, reply to that review comment (gh api -X POST /repos/${A.repoSlug}/pulls/${prNumber}/comments/<comment_id>/replies -f body=...); where it is not, collect those replies into one PR comment (gh pr comment ${prNumber}), each starting with its id. Post the bodies exactly as given.
${JSON.stringify(replyPlan)}`, `push-reply-r${round}`, 'Rounds')
  if (!pushed.ok) return { status: 'failed', stage: `push and reply, round ${round}`, detail: pushed.output, pr_number: prNumber, ledger: Object.values(ledger) }
  fix.replies.forEach(r => { if (ledger[r.id] && ledger[r.id].kind !== 'blocker') ledger[r.id].state = r.status === 'fixed' ? 'fixed' : r.status })

  const rr = await agent(`Re-review pull request changes in ${A.repo}. Do not modify the repository. Your job is narrow:
1. For each open blocker below, decide whether it is addressed in ${fixBase.output.trim()}..${fix.head_sha}. "Attempted" is not addressed. A dispute counts as addressed only if its evidence concretely refutes the blocker.
2. Look for NEW blockers introduced by that delta only (git diff ${fixBase.output.trim()}..${fix.head_sha}). Do not review unchanged code and do not raise follow-ups or nitpicks.
${BAR}
Open blockers and the fixer's replies:
${openBlockers().map(f => `${f.id}: ${f.text}\n  reply: ${(fix.replies.find(r => r.id === f.id) || {}).status || 'none'}: ${(fix.replies.find(r => r.id === f.id) || {}).text || ''}`).join('\n')}
Give new blockers ids R${round}-1, R${round}-2…. In "summary", give a one-paragraph verdict.`,
    { label: `re-review-r${round}`, phase: 'Rounds', schema: RER, model: 'opus', effort: 'medium' })
  rr.results.forEach(r => { if (ledger[r.id] && r.addressed) ledger[r.id].state = 'fixed' })
  const fresh = rr.new_findings.filter(f => f.kind === 'blocker')
  const refuted = await verify(fresh, `verify-r${round}`, 'Rounds')
  fresh.forEach(f => { ledger[f.id] = { ...f, state: refuted.find(r => r.id === f.id) ? 'refuted' : 'open' } })
  const toPost = fresh.filter(f => ledger[f.id].state === 'open')
  const p = await post(rr.summary, toPost, `post-r${round}`, 'Rounds')
  if (p.blocked) return blocked(`re-review round ${round}`, p.blocked, { pr_number: prNumber, ledger: Object.values(ledger) })
  ;(p.comments || []).forEach(c => { if (ledger[c.id]) Object.assign(ledger[c.id], { url: c.url, comment_id: c.comment_id }) })
  const resolvable = rr.results.filter(r => r.addressed && ledger[r.id] && ledger[r.id].comment_id).map(r => ledger[r.id].comment_id)
  if (resolvable.length) await mech(`On ${A.repoSlug} PR #${prNumber}, resolve the review threads whose first comment has one of these numeric ids: ${resolvable.join(', ')}. Use the GraphQL API: query pullRequest.reviewThreads (id, isResolved, comments(first:1){nodes{databaseId}}) and call resolveReviewThread for each match.`, `resolve-r${round}`, 'Rounds')
  rounds.push({ round, addressed: rr.results.filter(r => r.addressed).map(r => r.id), new_blockers: toPost.map(f => f.id), refuted: refuted.map(r => r.id) })
}

const all = Object.values(ledger)
return {
  status: openBlockers().length ? 'blocked_at_cap' : 'ready',
  pr_number: prNumber, pr_url: prUrl,
  open_blockers: openBlockers(),
  follow_ups: all.filter(f => f.state === 'follow-up' || (f.kind === 'follow-up' && f.state !== 'fixed')),
  dropped_nitpicks: all.filter(f => f.state === 'dropped').map(f => f.id),
  refuted: all.filter(f => f.state === 'refuted').map(f => ({ id: f.id, evidence: f.refutation })),
  rounds,
  ledger: all.map(f => ({ id: f.id, kind: f.kind, state: f.state, url: f.url || null })),
}
