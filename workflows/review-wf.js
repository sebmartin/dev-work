export const meta = {
  name: 'review-wf',
  description: 'dev-work: review a pull request, or re-review its fixes',
  whenToUse: 'Started by /dev-work:review only; launched on its own it does nothing.',
  phases: [{ title: 'Scout' }, { title: 'Verify' }, { title: 'Review' }, { title: 'Consolidate' }],
}

// The review workflow. /dev-work:review reads the pull request with gh and passes it in as args:
//   pr:           { number, url, repo: 'owner/name', title, body, author, head: sha40, base: sha40 (merge base), files: string[] }
//   logins:       the user's GitHub logins, non-empty
//   design:       the design text, '' when there is none
//   reviews:      [{ id, author, body, commit: sha40|null, state, submitted_at: ISO|null }]
//   threads:      [{ id, url, path, line, resolved, comments: [{ id, author, body, created_at, url }] }]
//   since_fetched: the last round's review commit was fetched into the worktree
//   codex:        { available: bool, reason: string }
// Launched without these it fails at once, before any agent runs.
//
// Credits: the lens, scout and consolidator prompts are adapted from the deep-review plugin. The Codex prompt and
// output schema are adapted from OpenAI's Codex plugin for Claude Code (adversarial-review.md and
// review-output.schema.json), Apache-2.0.

const GOAL = "The review exists to keep defects out and to stop the codebase getting worse. A defect is anything that makes the change wrong: a bug, a security hole, data at risk, or a change that doesn't do what it's meant to. Getting worse means harder or riskier to change later: weaker tests, stale docs, needless complexity, or code that drifts from the repository's patterns. Improving code the PR didn't touch is not this review's job. Never measure the review by how many findings it has."
const MARK = n => `<!-- dev-work:review round=${n} -->`
const REVIEW_RE = /<!-- dev-work:review round=(\d+) -->/
const DEVELOP_RE = /<!-- dev-work:develop round=(\d+) -->/
const DONE_RE = /Review done\./
const FULL_RE = /^\*\*Round \d+: full review\.\*\*/m
const SEV = { blocker: '🔴', robustness: '🟠', cleanup: '🟡' }

let lastLabel = ''
const ag = (prompt, opts = {}) => { lastLabel = opts.label; return agent(prompt, { agentType: 'dev-work:worker', ...opts }) }
const must = (r, stage) => { if (r === null || r === undefined) throw { stage, message: `${stage} returned nothing` }; return r }

let S = null

const result = (status, extra = {}) => ({
  status, round: S ? S.round : null, done: false, full_pass: false, open: { blocking: 0, should_fix: 0 }, needs_human: [],
  codex: { ran: false, reason: null }, review: null, skipped: null,
  output_tokens: typeof budget === 'object' && budget ? budget.spent() : 0, ...extra,
})

const isStr = v => typeof v === 'string'
const inputsOk = a => {
  try {
    const sha40 = /^[0-9a-f]{40}$/
    const p = a.pr
    return Number.isInteger(p.number) && isStr(p.head) && sha40.test(p.head) && isStr(p.base) && sha40.test(p.base)
      && isStr(p.repo) && isStr(p.url) && isStr(p.title) && isStr(p.body) && Array.isArray(p.files)
      && Array.isArray(a.logins) && a.logins.length > 0 && a.logins.every(l => isStr(l) && l !== '')
      && isStr(a.design) && Array.isArray(a.reviews) && Array.isArray(a.threads)
      && typeof a.since_fetched === 'boolean' && typeof a.codex === 'object' && a.codex !== null && typeof a.codex.available === 'boolean'
  } catch { return false }
}

const main = async () => {
  if (!inputsOk(args)) return result('failed', { stage: 'inputs', error: 'review-wf is started by /dev-work:review, which reads the pull request and passes it in. Run /dev-work:review <PR> instead.' })
  const { pr, logins, reviews, threads } = args
  if (reviews.some(r => r && r.state === 'PENDING')) return result('failed', { stage: 'pending review', error: 'A pending review is waiting on this pull request; submit or delete it first.' })

  const norm = s => (isStr(s) ? s : '').replace(/\r\n/g, '\n')
  const who = c => {
    const b = norm(c.body)
    return REVIEW_RE.test(b) ? 'reviewer' : DEVELOP_RE.test(b) ? 'develop' : logins.includes(c.author) ? 'user' : 'human'
  }
  const sevOf = body => {
    const t = norm(body).trimStart()
    return t.startsWith(SEV.blocker) ? 'blocker' : t.startsWith(SEV.robustness) ? 'robustness' : t.startsWith(SEV.cleanup) ? 'cleanup' : null
  }

  const rounds = reviews
    .filter(r => r && r.submitted_at && !Number.isNaN(Date.parse(r.submitted_at)) && REVIEW_RE.test(norm(r.body)))
    .map(r => {
      const b = norm(r.body)
      return { round: Number(b.match(REVIEW_RE)[1]), commit: r.commit || null, at: Date.parse(r.submitted_at), full: FULL_RE.test(b), done: DONE_RE.test(b) }
    })
    .sort((x, y) => x.at - y.at)
  const last = rounds.length ? rounds[rounds.length - 1] : null

  const reviewerThreads = []
  const humanThreads = []
  let userReplyAt = null
  for (const t of threads) {
    if (!t || !Array.isArray(t.comments) || t.comments.length === 0) continue
    const comments = t.comments.map(c => ({ ...c, kind: who(c) }))
    const th = { ...t, severity: null, comments }
    if (comments[0].kind === 'reviewer') {
      th.severity = sevOf(comments[0].body)
      reviewerThreads.push(th)
      for (const c of comments) {
        const at = Date.parse(c.created_at)
        if (c.kind === 'user' && !Number.isNaN(at) && (userReplyAt === null || at > userReplyAt)) userReplyAt = at
      }
    } else humanThreads.push(th)
  }

  S = { mine: logins.includes(pr.author), rounds, last, round: last ? last.round + 1 : 1, fullPasses: rounds.filter(r => r.full).length, reviewerThreads, humanThreads, userReplyAt }

  if (S.last && S.last.done && !(S.userReplyAt > S.last.at)) {
    return result('done', { done: true, round: S.last.round, skipped: 'The review is already done; nothing was posted.' })
  }

  // Replaced by the round itself in the next task.
  must(await ag(`${GOAL}\n\nScout pull request #${pr.number} (${pr.title}).`, { label: 'scout', phase: 'Scout' }), 'scout')
  return result('done')
}

try { return await main() } catch (e) { return result('failed', { stage: (e && e.stage) || lastLabel, error: String((e && e.message) || (e && e.stage) || e) }) }
