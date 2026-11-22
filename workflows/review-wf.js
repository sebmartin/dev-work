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
//                 commit is the full head SHA the review was submitted on (GitHub's commit_id). Anything else is read
//                 as unknown: the change since that round is then the whole PR diff, and the run never skips as
//                 "nothing new".
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
const SETTLED = '**✅ Settled:**', STILL = '**Still open:**', PUSHBACK = '**Pushback:**', NEEDS = '**Needs a person:**'
// In every later-round prompt: when the fixes hold, a round with nothing new is the right outcome.
const NO_NEW = 'A round with no new findings is the expected result when the fixes hold: say so and stop.'
// On a 🔴 or 🟠 a round without a full pass found outside its fixes. Read back from a thread's first comment, it keeps
// that thread from blocking the done rule in later rounds too.
const NONBLOCKING = "_Found outside this round's fixes, so it doesn't hold up the review._"
const FOOTER ='Reviewed by agents with [dev-work](https://github.com/sebmartin/dev-work).'
// Full passes per PR, round 1 included; reviewer rounds since the later of the user's latest reply in a reviewer
// thread and the latest full pass.
const FULL_PASS_LIMIT = 2, ROUND_LIMIT = 3

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
const FIX_FINDINGS = obj({ findings: arr({ ...FINDING, properties: { ...FINDING.properties, in_fixes: bool }, required: [...FINDING.required, 'in_fixes'] }) })
const CODEX_SCHEMA = FINDINGS // written into the runner's prompt as JSON text for --output-schema
const CODEX_RUN = obj({ exit_code: int, output: str, stderr: str })
const SCOUT = obj({ surfaces: arr(obj({ file: str, tags: arr(oneOf(TAGS)) })), lenses: arr(oneOf(LENSES)), full_pass: bool, reason: str })
const CONSOLIDATED = obj({
  findings: arr(obj({ sources: arr(str), path: str, line: int, location: str, severity: SEVERITY, headline: str, lenses: arr(str),
    verdict: oneOf(['CONFIRMED', 'PLAUSIBLE']), mechanism: str, failure_scenario: str, fix: str, in_fixes: bool, post: bool })),
  refuted: arr(obj({ sources: arr(str), evidence: str })),
  covered: arr(obj({ sources: arr(str), thread: str })),
  human_replies: arr(obj({ thread: str, reply: str })),
  note: str,
})
const VERIFY = obj({ threads: arr(obj({ id: str, action: oneOf(['resolve', 'still_wrong', 'push_back', 'needs_person', 'none']),
  basis: oneOf(['fix', 'decline', 'user', 'none']), evidence: str, reply: str })) })

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
const SHA40 = /^[0-9a-f]{40}$/
const inputsOk = a => {
  try {
    const p = a.pr
    return Number.isInteger(p.number) && isStr(p.head) && SHA40.test(p.head) && isStr(p.base) && SHA40.test(p.base)
      && isStr(p.repo) && isStr(p.url) && isStr(p.title) && isStr(p.body) && Array.isArray(p.files)
      && Array.isArray(a.logins) && a.logins.length > 0 && a.logins.every(l => isStr(l) && l !== '')
      && isStr(a.design) && Array.isArray(a.reviews) && Array.isArray(a.threads)
      && typeof a.since_fetched === 'boolean' && typeof a.codex === 'object' && a.codex !== null && typeof a.codex.available === 'boolean'
  } catch { return false }
}
const hasDesign = () => args.design.trim() !== ''
const laterRound = () => S.round > 1
// Where the change since the last round starts: the last round's review commit, or the PR's base when that commit
// couldn't be fetched (a force-push), so the whole PR diff is the change.
const since = () => (S.last && S.last.commit && args.since_fetched ? S.last.commit : args.pr.base)
// Reviewer rounds since the later of the user's latest reply in a reviewer thread and the latest full pass, this round
// included. A full pass restarts the count.
const roundsSince = () => {
  if (S.fullPass) return 1
  const fulls = S.rounds.filter(r => r.full).map(r => r.at)
  const anchor = Math.max(S.userReplyAt === null ? -Infinity : S.userReplyAt, ...fulls, -Infinity)
  return 1 + S.rounds.filter(r => r.at >= anchor).length
}
const sinceText = () => `## The change since the last round

\`git diff ${since()} ${args.pr.head}\` is what changed since round ${S.last.round}. After a rebase this can include the base branch's own changes: review only what is part of the PR's own diff (\`git diff ${args.pr.base} ${args.pr.head}\`).`

// ---- Prompts ----

const stripMarks = s => norm(s).replace(new RegExp(REVIEW_RE.source, 'g'), '').replace(new RegExp(DEVELOP_RE.source, 'g'), '').trim()
const threadText = t => [
  `[thread ${t.id}] ${t.path || '(no file)'}${Number.isInteger(t.line) ? ':' + t.line : ''} (${t.resolved ? 'resolved' : 'open'})`,
  ...t.comments.map(c => `  ${c.kind}: ${stripMarks(c.body).replace(/\n/g, '\n    ')}`),
].join('\n')

// What every reviewer is given: the PR, how to see its change, its threads, and the design when there is one.
const prInfo = ({ withThreads = true } = {}) => {
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
  ]
  if (withThreads) parts.push(`## Comment threads

Each thread is \`[thread <id>] <path>:<line> (resolved|open)\`, then its comments in order, each with who wrote it: reviewer (this review's earlier rounds), develop (the author's agent), user (the person this review works for), human (anyone else).

${threads.map(threadText).join('\n\n') || 'None yet.'}`)
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

${laterRound() ? `${sinceText()}

## Whether this round needs a full review

Earlier rounds reviewed this pull request, and the comment threads above are what they found. This round normally reviews only the change since the last round. Decide whether that change needs a new full review of the whole pull request instead: full_pass true when it does something the earlier review never looked at, meaning it touches a risk surface the pull request didn't have before, it rewrites a large part of what was reviewed, or it adds substantial new behaviour beyond fixing the findings. Fixes to the findings, however many, are not a reason. When full_pass is true, reason says why in a short phrase a stranger can read in the review's summary (for example "adds a sync engine"); otherwise reason is ''.

Map the surfaces and pick the lenses for the whole pull request either way, for the full review you might call for.

${NO_NEW}

Return surfaces (every changed file in the pull request with its tags), lenses, full_pass and reason.` : `Return surfaces (every changed file with its tags), lenses, full_pass false and reason '' (this is the first review, which is a full one).`}`

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

If you find nothing real through this lens, return an empty list. Don't manufacture nitpicks.${laterRound() ? `\n\n${NO_NEW}` : ''}`

// A later round without a full pass: one reviewer over the change since the last round and what it could break.
const fixReviewPrompt = () => `${GOAL}

You are the fix reviewer for a later round of this review. Earlier rounds reviewed the whole pull request and posted their findings in the comment threads below; the author has since changed it, mostly to answer them. Another reviewer checks whether each finding's fix holds. You review the change since the last round itself: whether it is correct, and what it could break elsewhere in the pull request (a caller of changed code, an invariant the earlier code kept, a test or doc the change left stale). Read the code around each change, not just the diff hunk. Prefer fixes that match a pattern already used elsewhere in this repository, and cite the file and line of that pattern.

${prInfo()}

${sinceText()}

## What to return

findings: each finding with
- file: the repository-relative path, and line: the line it is about, preferably the changed line that causes it (0 for the whole file).
- headline: one line naming the problem.
- severity: your first guess at blocker, robustness or cleanup; it is finalised later. ${SEVERITIES}
- lens: \`fix-review\`.
- mechanism: why it's wrong, the root cause with evidence. Cite the lines and files that prove it.
- failure_scenario: a concrete, specific sequence where this bites in practice, required for blocker and robustness. Not "this could fail" but which input or state leads to which wrong result.
- fix: the concrete change, pointing at the pattern already in the repository when there is one.
- in_fixes: true when the problem is in the change since the last round, false when it is in code that change didn't touch.

Don't raise again what a thread above already raises. Don't manufacture nitpicks.

${NO_NEW}`

const rawText = r => `- ${r.id} (${r.severity}, ${r.source}): ${r.headline} at ${r.file}:${r.line}, lens ${r.lens}${typeof r.in_fixes === 'boolean' ? `, ${r.in_fixes ? 'in' : 'outside'} the change since the last round` : ''}. Mechanism: ${r.mechanism} Failure scenario: ${r.failure_scenario || '(none given)'} Fix: ${r.fix}`

// The consolidator sees the threads and this round's raw findings, nothing from earlier rounds' runs: a finding an
// earlier round didn't post exists nowhere for it to raise again.
const consolidatorPrompt = (surfaces, { fullPass }) => {
  const fixRound = !fullPass
  const work = [
    `Dedupe across sources by (file, line, root issue). The same root issue often comes from several ${fixRound ? 'sources' : 'lenses'}. Merge them into one finding with the sharpest framing; list every source id merged into it in \`sources\` and every lens that raised it in \`lenses\`. Several sources raising it independently is a confidence signal; verify a finding with one source harder before it survives.`,
    `Verify every finding against the code, never on the source's word. Re-read the cited lines; if a source says a function returns X, open that function. Read-only inspection (grep, git blame, git log -L) is fine. Give each finding a verdict: CONFIRMED when you can name the triggering input or state and the wrong result, and quote the line; PLAUSIBLE when the mechanism is real but the trigger depends on runtime, config or timing you can't pin down from the repository. Refute a finding only when the code proves it wrong (factually wrong, provably impossible, or already guarded in this change): leave it out of \`findings\` and put its source ids in \`refuted\` with the file:line that proves it. Never refute a real but uncertain finding for being speculative; keep it as PLAUSIBLE.`,
    `Dedupe against the existing comment threads${laterRound() && fullPass ? ": every thread above, this review's own earlier findings included, open or resolved. This is a full review run again, so it will find much of what earlier rounds already posted" : ''}. When a thread already raises the same root issue, leave the finding out of \`findings\` and put its source ids in \`covered\` with that thread's id (the id in \`[thread <id>]\`). Never post what a person or an earlier round already raised.`,
    ...(fullPass ? [`Completeness check. Compare the scout's flagged surfaces with what came back. When a flagged surface came back suspiciously thin (a persistence surface with no data-integrity finding, an auth or untrusted_input surface with no security finding), review that surface yourself through the missing lens, and add what you find with \`sources\` empty.`] : []),
    `Final severity. ${SEVERITIES} A source's severity is a first guess: set the one the evidence supports.`,
    `Weigh each cleanup finding on impact (what goes wrong, and for whom, if it is left), effort (how big the fix is) and rabbit-hole risk (whether the fix stays contained, or invites a debate, a redesign or changes across the pull request). Set \`post\` true only when the impact is worth the effort and the fix stays contained. A cleanup finding with no impact is not posted, whatever the effort. Keep every cleanup finding that survived verification in \`findings\`, with \`post\` false when it isn't worth posting${fullPass ? ', so the summary can count how many were left out' : ''}.${fixRound ? ' In this round a cleanup finding outside the change since the last round is never posted.' : ''} Blocker and robustness findings are always posted, whatever \`post\` says.`,
    'Order the findings by severity, blockers first.',
  ]
  return `${GOAL}

You are the consolidator of this review. ${fixRound
    ? 'This round reviews the change since the last round: the fix reviewer looked at it and returned raw, unfiltered findings, listed below by id.'
    : 'Several reviewers each looked at the pull request through one lens and returned raw, unfiltered findings, listed below by id.'} You turn them into this round's comments: deduped, verified against the code, with their final severity, each written so a stranger can act on it. What you write in a finding is posted as it is.

${prInfo()}${laterRound() ? `\n\n${sinceText()}` : ''}

## The scout's surface map

${surfaces.map(s => `- ${s.file}: ${Array.isArray(s.tags) && s.tags.length ? s.tags.join(', ') : 'no surfaces'}`).join('\n') || '(none)'}

## Raw findings

${raw.map(rawText).join('\n') || '(none: no reviewer found anything)'}

## The work

${work.map((w, i) => `${i + 1}. ${w}`).join('\n')}

Account for every raw finding id: each goes in the \`sources\` of the finding it was merged into, or in \`refuted\`, or in \`covered\`. A blocker or robustness id missing from all three is posted by itself as its source wrote it, so dropping one silently duplicates or resurrects it.

## Writing each finding

Each finding is posted as an inline comment in the format: a first line with the severity emoji, the headline, the location, the lenses and the verdict; then **Mechanism.**, **Failure scenario.** and **Fix.** paragraphs. Code assembles that from your fields:
- path and line: where the comment goes. Anchor it on the changed line that causes the problem. A finding about an effect outside the diff (a caller the pull request didn't touch, a doc it left stale) goes on the changed line that causes the effect, which nearly always exists; failing that, set line 0 for a file-level comment on the most closely related changed file.
- location: the file:line the headline shows, where the problem is; it may be outside the diff.
- headline: one line naming the problem.
- mechanism: why it's wrong, the root cause with evidence: cite the lines that prove it ("verified: \`grep -c foo lock\` gives 0", "the override is at \`client.py:16-22\`"). Concrete beats confident.
- failure_scenario: a concrete, specific sequence where it bites in practice, required for blocker and robustness. Not "this could fail" but which input or state leads to which wrong result. For a cleanup finding it may be empty.
- fix: the concrete change, with a short snippet when it helps, pointing at the pattern already in the repository when there is one.
- in_fixes: ${laterRound()
    ? 'true when the problem is in the change since the last round, false when it is in code that change didn\'t touch. A source\'s in_fixes is a first guess: set the one the code supports.'
    : 'false; this round reviews the whole pull request.'}
- Link code with full-SHA permalinks: https://github.com/${args.pr.repo}/blob/${args.pr.head}/<path>#L<a>-L<b>.
- Every comment stands alone for a stranger reading the pull request. Never quote the design or refer to it, to the reviewers, or to anything the reader can't see.

note: a sentence for the review's summary, only for something the threads don't already say; usually ''. Never list or repeat findings in it, and never write a status: code writes the status.

human_replies: a reply in a thread a person started (its first comment is from user or human), only when you have something to add there, such as evidence that answers their question. A finding a person already raised goes in \`covered\`, never in a reply.${laterRound() ? `\n\n${NO_NEW}` : ''}`
}

// ---- Later rounds: what the verifier is asked, and what code does with its answers ----

// Where a reviewer thread stands, from GitHub's state and the latest reviewer reply after the opening comment.
const latestReviewerReply = t => {
  const mine = t.comments.slice(1).filter(c => c.kind === 'reviewer')
  return mine.length ? norm(mine[mine.length - 1].body).trimStart() : null
}
const priorState = t => {
  const r = latestReviewerReply(t)
  if (r !== null) {
    if (r.startsWith(SETTLED)) return 'closed'
    if (r.startsWith(NEEDS)) return 'needs_person'
    if (r.startsWith(STILL) || r.startsWith(PUSHBACK)) return 'open'
  }
  return t.resolved ? 'closed' : 'open'
}
// Reviewer threads to check this round: unresolved ones not already settled, and resolved ones (by anyone) with no
// settled reply from the reviewer.
const toVerify = () => S.reviewerThreads.filter(t => {
  const r = latestReviewerReply(t)
  return t.resolved ? !(r !== null && r.startsWith(SETTLED)) : priorState(t) !== 'closed'
})

const verifierPrompt = (threads, since) => `${GOAL}

You are the verifier for a later round of this review. Earlier rounds posted findings, each in its own thread. The author's side has answered some: develop (the author's agent) says it fixed a finding or declined it, a person may have replied, and someone may have resolved a thread. For each thread below, decide whether the finding is settled and say so in the thread.

${prInfo({ withThreads: false })}

## What changed since the last round

\`git diff ${since} ${args.pr.head}\`

## The threads to answer

Each comment shows who wrote it: reviewer (this review's earlier rounds), develop (the author's agent), user (the person this review works for), human (anyone else).

${threads.map(threadText).join('\n\n')}

## The rules

For every thread above, return one entry (id, action, basis, evidence, reply):
- A claimed fix, or a thread whose code was touched: check the code at the head, not the reply. When the fix holds, action resolve, basis fix. When it doesn't, action still_wrong, basis fix, and the reply says what is still wrong.
- A decline (develop or a person says it will not be changed): when the reasoning holds, action resolve, basis decline. Otherwise push back once, action push_back, basis decline, with specific evidence. When the reviewer already pushed back in this thread, action needs_person, and the reply says what each side holds.
- A reply from user settles the finding. "Leave it" is action resolve, basis user. "Fix it" keeps it open (action none, or still_wrong when the code still has the problem).
- A reply from human is the author's side: judge it as you judge develop's. It never settles a finding by itself.
- No reply and no change: action none.
- A thread someone else resolved is checked like a claimed fix: reopen it (still_wrong) when the code doesn't hold up.
- Evidence is a file:line for every resolve except one the user settled. Without it the resolve is not accepted.
- Replies are a few lines, cite file:line, and stand alone for a stranger reading the pull request. Never quote the design or refer to anything the reader can't see. Leave reply empty for action none.
- ${NO_NEW}`

// What the verifier's answers turn into, all of it decided here. Ids not in toVerify() are ignored and a missing thread
// is none. A resolve needs a file:line or the user's own reply; without one it is none.
const applyVerdicts = vs => {
  const pending = new Map(toVerify().map(t => [t.id, t]))
  const given = new Map(list(vs).filter(x => isStr(x.id) && pending.has(x.id)).map(x => [x.id, x]))
  const out = { replies: [], resolve: [], unresolve: [], states: [], needsHuman: [] }
  const mark = `\n\n${MARK(S.round)}`
  const says = (t, action) => {
    const v = given.get(t.id) || {}
    const reply = isStr(v.reply) ? v.reply.trim() : ''
    if (action === 'none' || reply === '') return null
    return { v, reply }
  }
  const needs = (t, why) => out.needsHuman.push({ thread: t.id, url: t.url, why })
  for (const t of S.reviewerThreads) {
    const v = given.get(t.id)
    let action = v && isStr(v.action) ? v.action : 'none'
    if (action === 'resolve') {
      const byUser = v.basis === 'user' && t.comments.some(c => c.kind === 'user')
      if (!byUser && !(isStr(v.evidence) && EVIDENCE_RE.test(v.evidence))) action = 'none'
    }
    if (action === 'push_back') {
      if (t.comments.slice(1).some(c => c.kind === 'reviewer' && norm(c.body).trimStart().startsWith(PUSHBACK))) action = 'needs_person'
    }
    const s = says(t, action)
    let state = priorState(t)
    if (!s) action = 'none'
    else if (action === 'resolve') {
      const cite = v.basis === 'user' ? '' : ` (${v.evidence.trim()})`
      out.replies.push({ thread: t.id, body: `${SETTLED} ${s.reply}${cite}${mark}` })
      if (S.mine && !t.resolved) out.resolve.push(t.id)
      state = 'closed'
    } else if (action === 'still_wrong') {
      out.replies.push({ thread: t.id, body: `${STILL} ${s.reply}${mark}` })
      if (S.mine && t.resolved) out.unresolve.push(t.id)
      state = 'open'
    } else if (action === 'push_back') {
      out.replies.push({ thread: t.id, body: `${PUSHBACK} ${s.reply}${mark}` })
      state = 'open'
    } else if (action === 'needs_person') {
      out.replies.push({ thread: t.id, body: `${NEEDS} ${s.reply}${mark}` })
      needs(t, s.reply)
      state = 'needs_person'
    } else action = 'none'
    if (action === 'none' && state === 'needs_person') needs(t, stripMarks(latestReviewerReply(t) || '').slice(NEEDS.length).trim())
    out.states.push({ severity: t.severity, state, nonblocking: t.nonblocking })
  }
  return out
}

// ---- The round ----

// Every raw finding, as each source returned it: { id: '<source>-<i>', source, ...FINDING }.
const raw = []
const addRaw = (source, findings) => {
  list(findings).forEach((f, i) => raw.push({ ...f, id: `${source}-${i + 1}`, source }))
}

// ---- Codex ----

// Adapted from adversarial-review.md in OpenAI's Codex plugin for Claude Code (Apache-2.0): the role, stance, attack
// surface, method and finding bar are its; the output contract is this review's own schema.
const codexPrompt = () => `${GOAL}

<role>
You are Codex performing an adversarial software review.
Your job is to break confidence in the change, not to validate it.
</role>

<task>
Review the pull request below as if you are trying to find the strongest reasons this change should not ship yet.
</task>

<operating_stance>
Default to skepticism.
Assume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.
Do not give credit for good intent, partial fixes, or likely follow-up work.
If something only works on the happy path, treat that as a real weakness.
</operating_stance>

<attack_surface>
Prioritize the kinds of failures that are expensive, dangerous, or hard to detect:
- auth, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible state changes
- rollback safety, retries, partial failure, and idempotency gaps
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty-state, null, timeout, and degraded dependency behavior
- version skew, schema drift, migration hazards, and compatibility regressions
- observability gaps that would hide failure or make recovery harder
</attack_surface>

<review_method>
Actively try to disprove the change.
Look for violated invariants, missing guards, unhandled failure paths, and assumptions that stop being true under stress.
Trace how bad inputs, retries, concurrent actions, or partially completed operations move through the code.
</review_method>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding should answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<structured_output_contract>
Return only valid JSON matching the provided schema, with no text around it.
Keep the output compact and specific.
Every finding has: file (repository-relative path), line (the line it is about, 0 for the whole file), headline (one line), severity (one of blocker, robustness, cleanup), lens (always "codex"), mechanism (the root cause), failure_scenario (a concrete sequence of input or state leading to the wrong result), fix (the concrete change).
Use blocker for a defect that must not ship, robustness for data correctness or robustness, cleanup only for something that makes the code worse to change later. If the change looks safe, return {"findings": []}.
</structured_output_contract>

<grounding_rules>
Be aggressive, but stay grounded.
Every finding must be defensible from the repository context or tool outputs.
Do not invent files, lines, code paths, incidents, attack chains, or runtime behavior you cannot support.
If a conclusion depends on an inference, state that explicitly in the finding and keep it honest.
</grounding_rules>

<calibration_rules>
Prefer one strong finding over several weak ones.
Do not dilute serious issues with filler.
If the change looks safe, say so directly and return no findings.${laterRound() ? `\n${NO_NEW}` : ''}
</calibration_rules>

<repository_context>
${prInfo()}
</repository_context>`

// The fence around the Codex prompt is longer than any backtick run inside it: the PR body, threads and design carry
// their own ``` code blocks, and a plain triple fence would close at the first of them.
const runnerPrompt = () => {
  const text = codexPrompt()
  const fence = '`'.repeat(Math.max(3, Math.max(0, ...(text.match(/`+/g) || []).map(m => m.length)) + 1))
  return `You run one command for a review and hand back what it produced. You are not a reviewer: do not review anything, and never retry, fix, summarise or reword the output.

1. Make a temporary directory with \`mktemp -d\`; call it <dir>.
2. Write the text between the two fence lines below (a line of only backticks, the same length at both ends; backtick lines inside the text belong to it), exactly as it is, to <dir>/prompt.md.
3. Write this JSON, exactly as it is, to <dir>/schema.json:
${JSON.stringify(CODEX_SCHEMA)}
4. From the current directory, run \`codex exec -s read-only --output-schema <dir>/schema.json -o <dir>/out.json - < <dir>/prompt.md\` with the Bash timeout at its maximum, 600000 ms.
5. Return exit_code: the command's exit status, or -1 if it timed out or couldn't start. Return output: the full contents of <dir>/out.json verbatim, or '' if it is missing. Return stderr: the last 20 lines of the command's error output.
6. Remove <dir>.

${fence}
${text}
${fence}`
}

const FINDING_TYPES = { file: isStr, line: Number.isInteger, headline: isStr, severity: v => Object.keys(SEV).includes(v), lens: isStr, mechanism: isStr, failure_scenario: isStr, fix: isStr }
// The check that decides whether Codex contributes: its run is accepted only on exit 0 with output that parses
// against the schema. Anything else is a reason, never findings.
const codexFindings = r => {
  if (r === null || r === undefined || typeof r !== 'object') return { reason: 'the Codex runner returned nothing' }
  if (r.exit_code !== 0) {
    const last = norm(r.stderr).split('\n').map(l => l.trim()).filter(Boolean).pop() || 'no error output'
    return { reason: `codex exited with status ${r.exit_code}: ${last}` }
  }
  if (!isStr(r.output) || r.output.trim() === '') return { reason: 'codex returned empty output' }
  let out
  try { out = JSON.parse(r.output) } catch { return { reason: 'codex output is not JSON (cut short?)' } }
  const ok = out && typeof out === 'object' && Array.isArray(out.findings)
    && out.findings.every(x => x && typeof x === 'object' && Object.entries(FINDING_TYPES).every(([k, check]) => check(x[k])))
  return ok ? { findings: out.findings } : { reason: 'codex output does not match the schema' }
}

// The runner's thunk for the lens fan-out, or null when Codex isn't available. It catches its own throw as null.
const codexThunk = () => (args.codex.available
  ? async () => { try { return await ag(runnerPrompt(), { label: 'codex', phase: 'Review', model: 'haiku', effort: 'low', schema: CODEX_RUN }) } catch { return null } }
  : null)
// Turns the runner's run into the review's codex status; a Codex failure never fails the run.
const runCodex = run => {
  if (!args.codex.available) return { ran: false, reason: `not available: ${args.codex.reason || 'no reason given'}`, findings: [] }
  const r = codexFindings(run)
  if (!r.findings) return { ran: false, reason: r.reason, findings: [] }
  addRaw('codex', r.findings)
  return { ran: true, reason: null, findings: r.findings }
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
  // A 🔴 or 🟠 a round without a full pass found outside its fixes is posted but doesn't block: the last full pass
  // covered that code.
  const nonblocking = f => BLOCKING.includes(f.severity) && !fullPass && f.in_fixes !== true
  return { posted: posted.map(f => anchor({ ...f, nonblocking: nonblocking(f) })), droppedMinor }
}

const render = (f, round) => {
  const lenses = Array.isArray(f.lenses) && f.lenses.length ? ` · ${f.lenses.join(', ')}` : ''
  const parts = [`${SEV[f.severity]} **${f.headline}** · \`${f.location}\`${lenses} · ${f.verdict}`, `**Mechanism.** ${f.mechanism}`]
  if (f.severity !== 'cleanup' || (isStr(f.failure_scenario) && f.failure_scenario.trim())) parts.push(`**Failure scenario.** ${f.failure_scenario}`)
  parts.push(`**Fix.** ${f.fix}`)
  if (f.nonblocking) parts.push(NONBLOCKING)
  parts.push(MARK(round))
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
// Done when nothing blocking is open (threads waiting on a person and findings outside a round's fixes don't block),
// or when the round limit is reached.
const isDone = states => !states.some(x => x.state === 'open' && BLOCKING.includes(x.severity) && !x.nonblocking)
  || roundsSince() >= ROUND_LIMIT

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
      return { round: Number(b.match(REVIEW_RE)[1]), commit: isStr(r.commit) && SHA40.test(r.commit) ? r.commit : null, at: Date.parse(r.submitted_at), full: FULL_RE.test(b), done: DONE_RE.test(b) }
    })
    .sort((x, y) => x.at - y.at)
  const last = rounds.length ? rounds[rounds.length - 1] : null

  const reviewerThreads = []
  const humanThreads = []
  let userReplyAt = null
  for (const t of threads) {
    if (!t || !Array.isArray(t.comments) || t.comments.length === 0) continue
    const comments = t.comments.map(c => ({ ...c, kind: who(c) }))
    const th = { ...t, severity: null, nonblocking: false, comments }
    if (comments[0].kind === 'reviewer') {
      th.severity = sevOf(comments[0].body)
      th.nonblocking = norm(comments[0].body).includes(NONBLOCKING)
      reviewerThreads.push(th)
      for (const c of comments) {
        const at = Date.parse(c.created_at)
        if (c.kind === 'user' && !Number.isNaN(at) && (userReplyAt === null || at > userReplyAt)) userReplyAt = at
      }
    } else humanThreads.push(th)
  }

  S = { mine: logins.includes(pr.author), rounds, last, round: last ? last.round + 1 : 1, fullPasses: rounds.filter(r => r.full).length, fullPass: false, reviewerThreads, humanThreads, userReplyAt }

  // A run that posts nothing reports where the existing threads stand, as the last round left them.
  const standing = () => {
    const now = applyVerdicts([])
    return { round: S.last.round, open: openCounts(now.states), needs_human: now.needsHuman }
  }
  if (S.last && S.last.done && !(S.userReplyAt > S.last.at)) {
    return result('done', { ...standing(), done: true, skipped: 'The review is already done; nothing was posted.' })
  }
  // Nothing new: the same head as the last round and no reply in the reviewer's threads since it. A reply whose time
  // can't be read counts as new, so a reply is never skipped.
  const newReply = S.last && S.reviewerThreads.some(t => t.comments.some(c => {
    const at = Date.parse(c.created_at)
    return c.kind !== 'reviewer' && (Number.isNaN(at) || at > S.last.at)
  }))
  if (S.last && pr.head === S.last.commit && !newReply) {
    return result('done', { ...standing(), skipped: `nothing new since round ${S.last.round}: no new commit and no reply in the reviewer's threads; nothing was posted` })
  }

  const scout = must(await ag(scoutPrompt(), { label: 'scout', phase: 'Scout', ...tier('sonnet'), schema: SCOUT }), 'scout')
  const wantsFull = S.round > 1 && scout.full_pass === true
  const fullPass = S.round === 1 || (wantsFull && S.fullPasses < FULL_PASS_LIMIT)
  S.fullPass = fullPass
  const reason = isStr(scout.reason) && scout.reason.trim() ? scout.reason.trim() : 'no reason given'
  const limit = wantsFull && !fullPass
    ? `A full review was warranted (${reason}) but the limit of two per pull request was reached, so this needs a person.`
    : null

  // Later rounds: answer each earlier finding's thread before looking for anything new.
  const stale = toVerify()
  const verdicts = stale.length
    ? must(await ag(verifierPrompt(stale, since()), { label: 'verifier', phase: 'Verify', ...tier('opus'), schema: VERIFY }), 'verifier')
    : { threads: [] }
  const applied = applyVerdicts(verdicts.threads)

  const surfaces = list(scout.surfaces).filter(s => isStr(s.file))
  const tags = new Set(surfaces.flatMap(s => (Array.isArray(s.tags) ? s.tags : [])))
  const lensModel = name => (name === 'security' ? (tags.has('auth') || tags.has('untrusted_input') ? 'opus' : 'sonnet') : LENS_MODEL[name])

  // A full pass runs round 1's lenses and Codex over the whole PR; any other round, the fix reviewer over the change.
  let codex = { ran: false, reason: 'Codex runs only in a full pass' }
  if (fullPass) {
    const names = lensesFor(scout)
    const cx = codexThunk()
    const found = await parallel([...names.map(n => () => ag(lensPrompt(n), { label: `lens-${n}`, phase: 'Review', ...tier(lensModel(n)), schema: FINDINGS })), ...(cx ? [cx] : [])])
    names.forEach((n, i) => addRaw(n, must(found[i], `lens-${n}`).findings))
    codex = runCodex(cx ? found[names.length] : null)
  } else {
    const fr = must(await ag(fixReviewPrompt(), { label: 'fix-review', phase: 'Review', ...tier('opus'), schema: FIX_FINDINGS }), 'fix-review')
    addRaw('fix-review', fr.findings)
  }

  const c = must(await ag(consolidatorPrompt(surfaces, { fullPass }), { label: 'consolidator', phase: 'Consolidate', ...tier('opus'), schema: CONSOLIDATED }), 'consolidator')
  const { posted, droppedMinor } = toPost(c, { fullPass })

  const states = [...applied.states, ...posted.map(f => ({ severity: f.severity, state: 'open', nonblocking: f.nonblocking }))]
  const done = isDone(states)
  const open = openCounts(states)
  const humanIds = new Set(S.humanThreads.map(t => t.id))
  const replies = list(c.human_replies).filter(h => humanIds.has(h.thread) && isStr(h.reply) && h.reply.trim())
    .map(h => ({ thread: h.thread, body: `${h.reply.trim()}\n\n${MARK(S.round)}` }))

  const review = {
    event: S.mine ? 'COMMENT' : 'PENDING',
    commit: pr.head,
    body: summary({ round: S.round, fullPass, since: S.last ? S.last.round : null, done, open, droppedMinor, note: c.note, limit }),
    comments: posted.map(f => ({ path: f.path, line: f.line, body: render(f, S.round) })),
    replies: [...applied.replies, ...replies],
    resolve: applied.resolve,
    unresolve: applied.unresolve,
  }
  const needsHuman = [...applied.needsHuman, ...(limit ? [{ thread: null, url: null, why: limit }] : [])]
  return result('done', { done, round: S.round, full_pass: fullPass, open, needs_human: needsHuman, review, codex: { ran: codex.ran, reason: codex.reason } })
}

try { return await main() } catch (e) { return result('failed', { stage: (e && e.stage) || lastLabel, error: String((e && e.message) || (e && e.stage) || e) }) }
