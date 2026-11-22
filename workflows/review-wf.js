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
// It returns the round ready to post as `review`:
//   { event: 'COMMENT'|'PENDING', commit: pr.head, body, comments: [{ path, line (0 = file-level), body }],
//     replies: [{ thread, body }], resolve: [thread id], unresolve: [thread id] }
// plus the structured result: done, round, full_pass, open, needs_human, codex, output_tokens.
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
const BLOCKING = ['blocker', 'robustness']
// A file:line citation: what a refutation (and a resolve) has to show before it drops anything.
const EVIDENCE_RE = /[\w./-]+:\d+/
const FOOTER = 'Reviewed by agents with [dev-work](https://github.com/sebmartin/dev-work).'

// Every object is closed and every property required, so Codex's --output-schema (strict) can take the same schemas.
const str = { type: 'string' }, bool = { type: 'boolean' }, int = { type: 'integer' }
const obj = props => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false })
const arr = items => ({ type: 'array', items })
const oneOf = values => ({ type: 'string', enum: values })
const SEVERITY = oneOf(['blocker', 'robustness', 'cleanup'])
const LENSES = ['correctness', 'security', 'data-integrity', 'quality', 'testing', 'conventions', 'intent']
const TAGS = ['persistence', 'concurrency', 'auth', 'untrusted_input', 'tests_missing', 'config_only']
const FINDING = obj({ file: str, line: int, headline: str, severity: SEVERITY, lens: str, mechanism: str, failure_scenario: str, fix: str })
const FINDINGS = obj({ findings: arr(FINDING) })
const SCOUT = obj({ surfaces: arr(obj({ file: str, tags: arr(oneOf(TAGS)) })), lenses: arr(oneOf(LENSES)), full_pass: bool, reason: str })
const CONSOLIDATED = obj({
  findings: arr(obj({ sources: arr(str), path: str, line: int, location: str, severity: SEVERITY, headline: str, lenses: arr(str),
    verdict: oneOf(['CONFIRMED', 'PLAUSIBLE']), mechanism: str, failure_scenario: str, fix: str, in_fixes: bool, post: bool })),
  refuted: arr(obj({ sources: arr(str), evidence: str })),
  covered: arr(obj({ sources: arr(str), thread: str })),
  human_replies: arr(obj({ thread: str, reply: str })),
  note: str,
})

let lastLabel = ''
const ag = (prompt, opts = {}) => { lastLabel = opts.label; return agent(prompt, { agentType: 'dev-work:worker', ...opts }) }
const must = (r, stage) => { if (r === null || r === undefined) throw { stage, message: `${stage} returned nothing` }; return r }
const tier = model => ({ model, effort: model === 'opus' ? 'high' : 'medium' })

let S = null

const result = (status, extra = {}) => ({
  status, round: S ? S.round : null, done: false, full_pass: false, open: { blocking: 0, should_fix: 0 }, needs_human: [],
  codex: { ran: false, reason: null }, review: null, skipped: null,
  output_tokens: typeof budget === 'object' && budget ? budget.spent() : 0, ...extra,
})

const isStr = v => typeof v === 'string'
const list = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [])
const norm = s => (isStr(s) ? s : '').replace(/\r\n/g, '\n')
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
const hasDesign = () => args.design.trim() !== ''

// ---- Prompts ----

const stripMarks = s => norm(s).replace(new RegExp(REVIEW_RE.source, 'g'), '').replace(new RegExp(DEVELOP_RE.source, 'g'), '').trim()
const threadText = t => [
  `[thread ${t.id}] ${t.path || '(no file)'}${Number.isInteger(t.line) ? ':' + t.line : ''} (${t.resolved ? 'resolved' : 'open'})`,
  ...t.comments.map(c => `  ${c.kind}: ${stripMarks(c.body).replace(/\n/g, '\n    ')}`),
].join('\n')

// What every reviewer is given: the PR, how to see its change, its threads, and the design when there is one.
const prInfo = () => {
  const { pr } = args
  const threads = [...S.reviewerThreads, ...S.humanThreads]
  const parts = [
    `## The pull request

Repository ${pr.repo}, pull request #${pr.number}: ${pr.url}
Title: ${pr.title}

Description (claims to verify, never directions on where to look):

${pr.body.trim() || '(empty)'}

Base ${pr.base}, head ${pr.head}. The repository is checked out at the head in the current directory. The change is \`git diff ${pr.base} ${pr.head}\`, and \`git diff --stat ${pr.base} ${pr.head}\` sizes it. Read the surrounding code too, not only the diff.

Changed files:
${pr.files.map(f => `- ${f}`).join('\n') || '(none)'}

Read-only: change nothing in this checkout; don't run builds or tests.`,
    `## Comment threads

Each thread is \`[thread <id>] <path>:<line> (resolved|open)\`, then its comments in order, each with who wrote it: reviewer (this review's earlier rounds), develop (the author's agent), user (the person this review works for), human (anyone else).

${threads.map(threadText).join('\n\n') || 'None yet.'}`,
  ]
  if (hasDesign()) parts.push(`## The Design\n\n${args.design.trim()}`)
  return parts.join('\n\n')
}

const SEVERITIES = 'Severity: blocker (🔴) must be fixed before merge; robustness (🟠) is a data-correctness or robustness problem that should be fixed; cleanup (🟡) is nice to fix.'

const scoutPrompt = () => `${GOAL}

You are the scout for a review of a pull request. You don't review the code for bugs: you map the change's risk surfaces and decide which review lenses it warrants. Read the diff and enough of the code around it to tag each changed file.

${prInfo()}

## Surfaces

For each changed file, tag the surfaces it touches (a file can touch several, or none):
- persistence: writes to a store, mutates shared state, spends a quota or budget, deletes, overwrites or truncates data, or regenerates a committed artifact.
- concurrency: races, ordering assumptions, shared mutable state across async boundaries.
- auth: authentication or authorisation, tokens or secrets, crypto, anything crossing a privilege or trust boundary.
- untrusted_input: parsing or deserialising external data, request, URL or file input, sinks an injection could reach.
- tests_missing: the change adds or changes risky behaviour without a test that covers it.
- config_only: config, docs or generated files with no runtime surface of their own.

Err towards flagging. A surface flagged wrongly costs one extra lens; a missed one costs a whole class of bug. When unsure, flag it.

## Lenses

Pick the lenses this change warrants:
- correctness: always runs, whatever you pick.
- security: any auth or untrusted_input surface.
- data-integrity: any persistence surface.
- quality: real code whose structure, naming, duplication or docs a senior engineer would comment on.
- testing: any tests_missing surface, or tests the change adds or alters.
- conventions: changes the repository's CLAUDE.md or AGENTS.md files have rules about.${hasDesign() ? '\n- intent: always runs here, because there is a design.' : ''}

Return surfaces (every changed file with its tags), lenses, full_pass false and reason '' (this is the first review, which is a full one).`

const LENS_TEXT = {
  correctness: `Lens: correctness. Hunt for real bugs that will actually be hit: wrong logic, unhandled or swallowed errors, edge cases (empty input, null, NaN, zero, overflow, off-by-one), race conditions and concurrency, resource leaks, incorrect library or API usage, wrong types crossing a boundary. Trace the changed code paths, and trace across files: for a changed function, find its callers and check whether a changed return shape or type, a new failure mode or a new precondition breaks a consumer (an optional helper that now returns undefined, null or [] on a path a required caller assumes always succeeds is a classic). For behaviour the diff removed, name the invariant it used to enforce and find where the new code re-establishes it; if nowhere, that's a finding. Skip stylistic nits and anything a typechecker or linter would catch.`,
  security: `Lens: security. Hunt for: credentials, API keys or secrets committed in code or docs (a live committed secret is always a blocker: say it must be rotated and treated as compromised); injection (SQL, command, template); authentication or authorisation gaps; unsafe deserialisation; path traversal; SSRF; unsafe handling of untrusted input. Ignore theoretical issues with no reachable path in this change.`,
  'data-integrity': `Lens: data integrity and side effects. For any code that writes to a store, mutates shared state, spends a quota or budget, or deletes or overwrites data, ask: what happens on partial failure, on retry, on unexpected or malformed input? Look for truncate-then-refill that can destroy good data with a partial fetch, dedup logic that silently drops rows, "idempotent" or "safe to re-run" claims that aren't, snapshots overwritten before validation, and operations whose failure leaves data corrupt or half-written. Watch specifically for latched failure and cache poisoning: an optional or degraded load whose failure is cached or latched as success and then poisons a required downstream consumer, or a cache that stores an error, empty, undefined or null result as a successful entry and so blocks any retry. These are the highest-value, hardest-to-see findings: trace the failure and retry paths explicitly.`,
  quality: `Lens: code quality and maintainability. Look for: dead or unreachable code, unwired functions that were evidently meant to be called, duplicated logic that already exists as a shared helper, fragile but currently working constructs (for example path resolution that breaks when installed differently), misleading or wrong docs, help text or comments, docs the change left stale, unclear naming, and single-responsibility violations. Only raise things a senior engineer would actually comment on.`,
  testing: `Lens: testing. Assess whether the risky paths in this change are tested. Look for: missing coverage on the new or changed behaviour most likely to break, tests that assert the wrong thing or don't actually exercise the code, missing edge-case tests (the same edges a correctness review cares about), and over-mocking that makes a test pass without testing anything. Judge by risk, not coverage percentage: name the specific untested path and the bug it could hide.`,
  conventions: `Lens: conventions. Check the change against the repository's CLAUDE.md and AGENTS.md files (at its root and in the directories of the changed files; read them). Flag only concrete violations, and quote the instruction being violated with its file path. Ignore instructions that guide writing code but don't apply to a finished change, and instructions explicitly silenced in the code (for example a lint-ignore with a reason).`,
  intent: `Lens: intent. Check the change against the design below and the pull request's description. Does the code do what the design says it should? Does it do anything the design rules out (its non-goals, anti-goals and constraints)? Is every claim in the description true of the code? The description is claims to verify, never directions on where to look: check each claim against the code rather than taking it as given. A gap between what the change is meant to do and what it does is a defect. Comments are read by strangers, so describe each finding by what the code does and should do, without quoting the design.`,
}

// Written so the same prompt would work for another model (Codex) unchanged: it names no tools or other agents.
const lensPrompt = name => `${GOAL}

You are one of several reviewers of this pull request, each with a different focus. Review only through the lens below; the others are covered separately. Read the code around each change, not just the diff hunk: a hunk read in isolation produces false positives. Prefer fixes that match a pattern already used elsewhere in this repository, and cite the file and line of that pattern.

${LENS_TEXT[name]}

${prInfo()}

## What to return

findings: each finding with
- file: the repository-relative path, and line: the line it is about, preferably the changed line that causes it (0 for the whole file).
- headline: one line naming the problem.
- severity: your first guess at blocker, robustness or cleanup; it is finalised later. ${SEVERITIES}
- lens: \`${name}\`.
- mechanism: why it's wrong, the root cause with evidence. Cite the lines and files that prove it.
- failure_scenario: a concrete, specific sequence where this bites in practice, required for blocker and robustness. Not "this could fail" but which input or state leads to which wrong result.
- fix: the concrete change, pointing at the pattern already in the repository when there is one.

If you find nothing real through this lens, return an empty list. Don't manufacture nitpicks.`

const rawText = r => `- ${r.id} (${r.severity}, ${r.source}): ${r.headline} at ${r.file}:${r.line}, lens ${r.lens}. Mechanism: ${r.mechanism} Failure scenario: ${r.failure_scenario || '(none given)'} Fix: ${r.fix}`

const consolidatorPrompt = surfaces => `${GOAL}

You are the consolidator of this review. Several reviewers each looked at the pull request through one lens and returned raw, unfiltered findings, listed below by id. You turn them into this round's comments: deduped, verified against the code, with their final severity, each written so a stranger can act on it. What you write in a finding is posted as it is.

${prInfo()}

## The scout's surface map

${surfaces.map(s => `- ${s.file}: ${Array.isArray(s.tags) && s.tags.length ? s.tags.join(', ') : 'no surfaces'}`).join('\n') || '(none)'}

## Raw findings

${raw.map(rawText).join('\n') || '(none: no reviewer found anything)'}

## The work

1. Dedupe across sources by (file, line, root issue). The same root issue often comes from several lenses. Merge them into one finding with the sharpest framing; list every source id merged into it in \`sources\` and every lens that raised it in \`lenses\`. Several sources raising it independently is a confidence signal; verify a finding with one source harder before it survives.
2. Verify every finding against the code, never on the source's word. Re-read the cited lines; if a source says a function returns X, open that function. Read-only inspection (grep, git blame, git log -L) is fine. Give each finding a verdict: CONFIRMED when you can name the triggering input or state and the wrong result, and quote the line; PLAUSIBLE when the mechanism is real but the trigger depends on runtime, config or timing you can't pin down from the repository. Refute a finding only when the code proves it wrong (factually wrong, provably impossible, or already guarded in this change): leave it out of \`findings\` and put its source ids in \`refuted\` with the file:line that proves it. Never refute a real but uncertain finding for being speculative; keep it as PLAUSIBLE.
3. Dedupe against the existing comment threads. When a thread already raises the same root issue, leave the finding out of \`findings\` and put its source ids in \`covered\` with that thread's id (the id in \`[thread <id>]\`). Never post what a person already raised.
4. Completeness check. Compare the scout's flagged surfaces with what came back. When a flagged surface came back suspiciously thin (a persistence surface with no data-integrity finding, an auth or untrusted_input surface with no security finding), review that surface yourself through the missing lens, and add what you find with \`sources\` empty.
5. Final severity. ${SEVERITIES} A source's severity is a first guess: set the one the evidence supports.
6. Weigh each cleanup finding on impact (what goes wrong, and for whom, if it is left), effort (how big the fix is) and rabbit-hole risk (whether the fix stays contained, or invites a debate, a redesign or changes across the pull request). Set \`post\` true only when the impact is worth the effort and the fix stays contained. A cleanup finding with no impact is not posted, whatever the effort. Keep every cleanup finding that survived verification in \`findings\`, with \`post\` false when it isn't worth posting, so the summary can say how many were left out. Blocker and robustness findings are always posted, whatever \`post\` says.
7. Order the findings by severity, blockers first.

Account for every raw finding id: each goes in the \`sources\` of the finding it was merged into, or in \`refuted\`, or in \`covered\`. A blocker or robustness id left out of all three is posted by itself as its source wrote it, so leaving one out duplicates or resurrects it.

## Writing each finding

Each finding is posted as an inline comment in the format: a first line with the severity emoji, the headline, the location, the lenses and the verdict; then **Mechanism.**, **Failure scenario.** and **Fix.** paragraphs. Code assembles that from your fields:
- path and line: where the comment goes. Anchor it on the changed line that causes the problem. A finding about an effect outside the diff (a caller the pull request didn't touch, a doc it left stale) goes on the changed line that causes the effect, which nearly always exists; failing that, set line 0 for a file-level comment on the most closely related changed file.
- location: the file:line the headline shows, where the problem is; it may be outside the diff.
- headline: one line naming the problem.
- mechanism: why it's wrong, the root cause with evidence: cite the lines that prove it ("verified: \`grep -c foo lock\` gives 0", "the override is at \`client.py:16-22\`"). Concrete beats confident.
- failure_scenario: a concrete, specific sequence where it bites in practice, required for blocker and robustness. Not "this could fail" but which input or state leads to which wrong result. For a cleanup finding it may be empty.
- fix: the concrete change, with a short snippet when it helps, pointing at the pattern already in the repository when there is one.
- in_fixes: false; this round reviews the whole pull request.
- Link code with full-SHA permalinks: https://github.com/${args.pr.repo}/blob/${args.pr.head}/<path>#L<a>-L<b>.
- Every comment stands alone for a stranger reading the pull request. Never quote the design or refer to it, to the reviewers, or to anything the reader can't see.

note: a sentence for the review's summary, only for something the threads don't already say; usually ''. Never list or repeat findings in it, and never write a status: code writes the status.

human_replies: a reply in a thread a person started (its first comment is from user or human), only when you have something to add there, such as evidence that answers their question. A finding a person already raised goes in \`covered\`, never in a reply.`

// ---- The round ----

// Every raw finding, as each source returned it: { id: '<source>-<i>', source, ...FINDING }.
const raw = []
const addRaw = (source, findings) => {
  list(findings).forEach((f, i) => raw.push({ ...f, id: `${source}-${i + 1}`, source }))
}

const lensesFor = scout => {
  const picked = new Set([...(Array.isArray(scout.lenses) ? scout.lenses : []), 'correctness', ...(hasDesign() ? ['intent'] : [])])
  if (!hasDesign()) picked.delete('intent')
  return LENSES.filter(l => picked.has(l))
}
const LENS_MODEL = { correctness: 'opus', 'data-integrity': 'opus', intent: 'opus', quality: 'sonnet', testing: 'sonnet', conventions: 'sonnet' }

// ---- Posting rules ----

// A finding on a file the PR didn't change can't be an inline comment there: post it file-level on the first changed
// file, keeping where it is in the headline. The input has no diff hunks, so a line in a changed file but outside its
// hunks still goes out inline and GitHub rejects it at submit: /dev-work:review's posting step reposts such a comment
// file-level (line 0) on the same path.
const anchor = f => {
  const line = Number.isInteger(f.line) && f.line > 0 ? f.line : 0
  const location = isStr(f.location) && f.location.trim() ? f.location : line ? `${f.path}:${line}` : `${f.path}`
  return args.pr.files.includes(f.path) ? { ...f, line, location } : { ...f, path: args.pr.files[0], line: 0, location }
}

// The nitpick floor and the downgrade guard. 🔴 and 🟠 are always posted, and so is anything a source rated 🔴 or 🟠,
// whatever the consolidator rated it. A raw 🔴 or 🟠 the consolidator left out is posted from its source unless it
// was refuted with file:line evidence or is covered by a thread that exists. Unknown ids are ignored.
const toPost = (c, { fullPass }) => {
  const byId = new Map(raw.map(r => [r.id, r]))
  const threadIds = new Set([...S.reviewerThreads, ...S.humanThreads].map(t => t.id))
  const ids = e => (Array.isArray(e.sources) ? e.sources : []).filter(id => byId.has(id))
  const named = new Set()
  const posted = []
  let droppedMinor = 0
  for (const f of list(c.findings)) {
    const sources = ids(f)
    sources.forEach(id => named.add(id))
    const guarded = sources.some(id => BLOCKING.includes(byId.get(id).severity))
    if (BLOCKING.includes(f.severity) || guarded || (f.severity === 'cleanup' && f.post === true && (fullPass || f.in_fixes === true))) posted.push(f)
    else if (f.severity === 'cleanup') droppedMinor++
  }
  const refuted = new Set(list(c.refuted).filter(e => isStr(e.evidence) && EVIDENCE_RE.test(e.evidence)).flatMap(ids))
  const covered = new Set(list(c.covered).filter(e => threadIds.has(e.thread)).flatMap(ids))
  for (const r of raw) {
    if (!BLOCKING.includes(r.severity) || named.has(r.id) || refuted.has(r.id) || covered.has(r.id)) continue
    posted.push({ sources: [r.id], path: r.file, line: r.line, location: `${r.file}:${r.line}`, severity: r.severity, headline: r.headline,
      lenses: [r.source], verdict: 'PLAUSIBLE', mechanism: r.mechanism, failure_scenario: r.failure_scenario, fix: r.fix,
      in_fixes: r.in_fixes === true, post: true })
  }
  return { posted: posted.map(anchor), droppedMinor }
}

const render = (f, round) => {
  const lenses = Array.isArray(f.lenses) && f.lenses.length ? ` · ${f.lenses.join(', ')}` : ''
  const parts = [`${SEV[f.severity]} **${f.headline}** · \`${f.location}\`${lenses} · ${f.verdict}`, `**Mechanism.** ${f.mechanism}`]
  if (f.severity !== 'cleanup' || (isStr(f.failure_scenario) && f.failure_scenario.trim())) parts.push(`**Failure scenario.** ${f.failure_scenario}`)
  parts.push(`**Fix.** ${f.fix}`, MARK(round))
  return parts.join('\n\n')
}

// A note that looks like a status line, a round heading or a marker would be read back as one by a later run.
const statusLike = s => DONE_RE.test(s) || FULL_RE.test(s) || REVIEW_RE.test(s) || DEVELOP_RE.test(s)

// The review's body. Its status is written here, never by an agent.
const summary = ({ round, fullPass, since, done, open, droppedMinor, note, limit }) => {
  const b = open.blocking, s = open.should_fix
  const parts = [fullPass ? `**Round ${round}: full review.**` : `**Round ${round}: review of the changes since round ${since}.**`]
  parts.push(!done ? `Open: ${b} 🔴, ${s} 🟠.` : b + s === 0 ? 'No further findings. Review done.' : `Review done. Still open, for a person to weigh: ${b} 🔴, ${s} 🟠.`)
  if (limit) parts.push(limit)
  if (fullPass && droppedMinor > 0) parts.push(`${droppedMinor} minor point${droppedMinor === 1 ? ' was' : 's were'} left out.`)
  const extra = norm(note).trim()
  if (!done && extra && !statusLike(extra)) parts.push(extra)
  parts.push('---', FOOTER, MARK(round))
  return parts.join('\n\n')
}

// ---- Done rule ----

// states: [{ severity, state: 'open'|'closed'|'needs_person', nonblocking }]
const openCounts = states => {
  const n = sev => states.filter(x => x.severity === sev && (x.state === 'open' || x.state === 'needs_person')).length
  return { blocking: n('blocker'), should_fix: n('robustness') }
}
const isDone = states => !states.some(x => x.state === 'open' && BLOCKING.includes(x.severity) && !x.nonblocking)

const main = async () => {
  if (!inputsOk(args)) return result('failed', { stage: 'inputs', error: 'review-wf is started by /dev-work:review, which reads the pull request and passes it in. Run /dev-work:review <PR> instead.' })
  const { pr, logins, reviews, threads } = args
  if (reviews.some(r => r && r.state === 'PENDING')) return result('failed', { stage: 'pending review', error: 'A pending review is waiting on this pull request; submit or delete it first.' })

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

  const fullPass = true
  const scout = must(await ag(scoutPrompt(), { label: 'scout', phase: 'Scout', ...tier('sonnet'), schema: SCOUT }), 'scout')
  const surfaces = list(scout.surfaces).filter(s => isStr(s.file))
  const tags = new Set(surfaces.flatMap(s => (Array.isArray(s.tags) ? s.tags : [])))
  const lensModel = name => (name === 'security' ? (tags.has('auth') || tags.has('untrusted_input') ? 'opus' : 'sonnet') : LENS_MODEL[name])

  const names = lensesFor(scout)
  const found = await parallel(names.map(n => () => ag(lensPrompt(n), { label: `lens-${n}`, phase: 'Review', ...tier(lensModel(n)), schema: FINDINGS })))
  names.forEach((n, i) => addRaw(n, must(found[i], `lens-${n}`).findings))

  const c = must(await ag(consolidatorPrompt(surfaces), { label: 'consolidator', phase: 'Consolidate', ...tier('opus'), schema: CONSOLIDATED }), 'consolidator')
  const { posted, droppedMinor } = toPost(c, { fullPass })

  const states = posted.map(f => ({ severity: f.severity, state: 'open', nonblocking: false }))
  const done = isDone(states)
  const open = openCounts(states)
  const humanIds = new Set(S.humanThreads.map(t => t.id))
  const replies = list(c.human_replies).filter(h => humanIds.has(h.thread) && isStr(h.reply) && h.reply.trim())
    .map(h => ({ thread: h.thread, body: `${h.reply.trim()}\n\n${MARK(S.round)}` }))

  const review = {
    event: S.mine ? 'COMMENT' : 'PENDING',
    commit: pr.head,
    body: summary({ round: S.round, fullPass, since: S.last ? S.last.round : null, done, open, droppedMinor, note: c.note, limit: null }),
    comments: posted.map(f => ({ path: f.path, line: f.line, body: render(f, S.round) })),
    replies,
    resolve: [],
    unresolve: [],
  }
  return result('done', { done, round: S.round, full_pass: fullPass, open, review })
}

try { return await main() } catch (e) { return result('failed', { stage: (e && e.stage) || lastLabel, error: String((e && e.message) || (e && e.stage) || e) }) }
