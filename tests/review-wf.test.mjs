// Runs workflows/review-wf.js with stand-in agents, so its control flow, its prompts and its result can be
// checked without starting a model. Run with: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SCRIPT = readFileSync(new URL('../workflows/review-wf.js', import.meta.url), 'utf8')
  .replace(/^export const meta/m, 'const meta')

const GOAL_TEXT = "The review exists to keep defects out and to stop the codebase getting worse. A defect is anything that makes the change wrong: a bug, a security hole, data at risk, or a change that doesn't do what it's meant to. Getting worse means harder or riskier to change later: weaker tests, stale docs, needless complexity, or code that drifts from the repository's patterns. Improving code the PR didn't touch is not this review's job. Never measure the review by how many findings it has."

const sha = c => c.repeat(40)
const T0 = Date.parse('2026-01-01T00:00:00Z')
const iso = n => new Date(T0 + n * 3600 * 1000).toISOString()

const pr1 = { pr: { number: 7, url: 'https://github.com/o/r/pull/7', repo: 'o/r', title: 'T', body: 'PR-BODY', author: 'seb', head: sha('c'), base: sha('b'), files: ['a.js', 'b.js'] },
  logins: ['seb'], design: 'THE-DESIGN', reviews: [], threads: [], since_fetched: true, codex: { available: true, reason: '' } }

function review(round, { commit = sha('a'), at = round, full = false, done = false } = {}) {
  const head = full ? `**Round ${round}: full review.**` : `**Round ${round}: review of the changes since round ${round - 1}.**`
  const body = [head, done ? 'No further findings. Review done.' : '', `<!-- dev-work:review round=${round} -->`].filter(Boolean).join('\n\n')
  return { id: 'R' + round, author: 'seb', body, commit, state: 'COMMENTED', submitted_at: iso(at) }
}

function thread(id, firstBody, replies, { resolved = false } = {}, firstAuthor = 'seb') {
  const comments = [{ id: id + 'c0', author: firstAuthor, body: firstBody, created_at: iso(0.5), url: 'https://github.com/o/r/pull/7#' + id + 'c0' },
    ...(replies || []).map((r, i) => ({ id: id + 'c' + (i + 1), author: r.author, body: r.body, created_at: iso(r.at), url: 'https://github.com/o/r/pull/7#' + id + 'c' + (i + 1) }))]
  return { id, url: 'https://github.com/o/r/pull/7#' + id, path: 'a.js', line: 3, resolved, comments }
}

// What each agent returns, by label, unless a test overrides it. Later tasks add to these.
const empty = { findings: [], refuted: [], covered: [], human_replies: [], note: '' }
const defaults = {
  scout: () => ({ surfaces: [{ file: 'a.js', tags: ['persistence'] }], lenses: ['correctness', 'quality'], full_pass: false, reason: '' }),
  lens: () => ({ findings: [] }),
  consolidator: () => empty,
  codex: () => ({ exit_code: 0, output: JSON.stringify({ findings: [] }), stderr: '' }),
}
// A consolidated finding, and a raw finding as a lens returns it.
const f = over => ({ sources: ['correctness-1'], path: 'a.js', line: 3, location: 'a.js:3', severity: 'robustness', headline: 'H', lenses: ['correctness'], verdict: 'CONFIRMED', mechanism: 'M', failure_scenario: 'FS', fix: 'FX', in_fixes: false, post: false, ...over })
const rawF = over => ({ file: 'a.js', line: 3, headline: 'H', severity: 'robustness', lens: 'correctness', mechanism: 'M', failure_scenario: 'FS', fix: 'FX', ...over })
const cx = over => ({ file: 'a.js', line: 3, headline: 'H', severity: 'robustness', lens: 'codex', mechanism: 'M', failure_scenario: 'FS', fix: 'FX', ...over })
const kind = label => (label.startsWith('lens-') ? 'lens' : label)

async function run(args, overrides = {}) {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt, opts })
    const respond = overrides[opts.label] || overrides[kind(opts.label)] || defaults[opts.label] || defaults[kind(opts.label)] || (() => null)
    return respond(prompt, opts.label, calls)
  }
  const parallel = thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const budget = { spent: () => 4321 }
  const context = vm.createContext({ args, agent, parallel, phase: () => {}, log: () => {}, budget })
  const result = await vm.runInContext(`(async () => {\n${SCRIPT}\n})()`, context)
  // The result comes from another realm; a JSON round trip makes it plain data for the assertions.
  return { result: JSON.parse(JSON.stringify(result)), calls, prompt: label => (calls.find(c => c.label === label) || {}).prompt }
}

test('launched without the skill\'s inputs it fails at once and runs no agent', async () => {
  for (const args of [undefined, {}, { ...pr1, logins: [] }, { ...pr1, pr: { ...pr1.pr, head: 'main' } }, { ...pr1, threads: undefined }]) {
    const { result, calls } = await run(args)
    assert.equal(result.status, 'failed')
    assert.equal(result.stage, 'inputs')
    assert.match(result.error, /started by \/dev-work:review/)
    assert.equal(calls.length, 0)
  }
})

test('a pending review on the PR fails before any agent', async () => {
  const { result, calls } = await run({ ...pr1, reviews: [{ id: 'R', author: 'seb', body: '', commit: null, state: 'PENDING', submitted_at: null }] })
  assert.equal(result.stage, 'pending review'); assert.equal(calls.length, 0)
})

test('a review already done posts nothing and runs no agent', async () => {
  const { result, calls } = await run({ ...pr1, reviews: [review(1, { full: true }), review(2, { done: true })] })
  assert.equal(result.status, 'done'); assert.equal(result.done, true); assert.equal(result.review, null)
  assert.equal(result.round, 2); assert.match(result.skipped, /already done/); assert.equal(calls.length, 0)
})

test('a user reply in a reviewer thread after a done round reopens the review', async () => {
  // review 2 done at t=2; the user replies unmarked in a reviewer thread at t=3: round 3 runs
  const { calls, result } = await run({ ...pr1, reviews: [review(1, { full: true, at: 1 }), review(2, { done: true, at: 2 })], threads: [thread('T1', '🟠 **x** <!-- dev-work:review round=1 -->', [{ author: 'seb', body: 'leave it', at: 3 }])] }, { scout: () => null })
  assert.equal(result.round, 3); assert.equal(calls[0].label, 'scout')
})

test('a comment with a null author is a human\'s and does not crash', async () => {
  const { result } = await run({ ...pr1, threads: [thread('H1', 'looks off', [], {}, null)] }, { scout: () => null })
  assert.equal(result.stage, 'scout')
})

test('an agent that returns nothing ends the run as a failed result, never a throw', async () => {
  const { result } = await run(pr1, { scout: () => null })
  assert.equal(result.status, 'failed'); assert.equal(result.stage, 'scout'); assert.equal(result.round, 1)
  const thrown = await run(pr1, { scout: () => { throw new Error('usage limit reached') } })
  assert.equal(thrown.result.stage, 'scout'); assert.match(thrown.result.error, /usage limit reached/)
})

test('every agent runs as a dev-work worker and its prompt starts with the review\'s goal', async () => {
  const { calls } = await run(pr1)
  for (const c of calls) { assert.equal(c.opts.agentType, 'dev-work:worker', c.label); assert.ok(c.label === 'codex' || c.prompt.startsWith(GOAL_TEXT), c.label) }
})

test('round 1 runs the scout, the lenses it picks plus correctness and intent, then the consolidator', async () => {
  const { calls } = await run({ ...pr1, codex: { available: false, reason: 'not installed' } }, { scout: () => ({ surfaces: [], lenses: ['security'], full_pass: false, reason: '' }) })
  assert.deepEqual(calls.map(c => c.label).sort(), ['consolidator', 'lens-correctness', 'lens-intent', 'lens-security', 'scout'])
  assert.ok(calls.findIndex(c => c.label === 'consolidator') === calls.length - 1)
})

test('without a design the intent lens never runs and the review still completes', async () => {
  const { calls, result } = await run({ ...pr1, design: '' }, { scout: () => ({ surfaces: [], lenses: ['intent'], full_pass: false, reason: '' }) })
  assert.ok(!calls.some(c => c.label === 'lens-intent')); assert.equal(result.status, 'done')
  assert.doesNotMatch(calls.map(c => c.prompt).join('\n'), /THE-DESIGN/)
})

test('the intent lens checks the design and treats the description as claims', async () => {
  const { prompt } = await run(pr1, { scout: () => ({ surfaces: [], lenses: [], full_pass: false, reason: '' }) })
  assert.match(prompt('lens-intent'), /THE-DESIGN/); assert.match(prompt('lens-intent'), /PR-BODY/); assert.match(prompt('lens-intent'), /claims to verify/)
})

test('round 1 is one COMMENT review on the user\'s own PR: findings inline, marker on each, summary and footer', async () => {
  const { result } = await run(pr1, { 'lens-correctness': () => ({ findings: [rawF({ severity: 'robustness' })] }), consolidator: () => ({ ...empty, findings: [f()] }) })
  const r = result.review
  assert.equal(r.event, 'COMMENT'); assert.equal(r.commit, sha('c')); assert.equal(r.comments.length, 1)
  assert.deepEqual([r.comments[0].path, r.comments[0].line], ['a.js', 3])
  assert.match(r.comments[0].body, /^🟠 \*\*H\*\* · `a\.js:3` · correctness · CONFIRMED\n\n\*\*Mechanism\.\*\* M\n\n\*\*Failure scenario\.\*\* FS\n\n\*\*Fix\.\*\* FX/)
  assert.match(r.comments[0].body, /<!-- dev-work:review round=1 -->$/)
  assert.match(r.body, /^\*\*Round 1: full review\.\*\*/); assert.match(r.body, /Open: 0 🔴, 1 🟠\./)
  assert.match(r.body, /Reviewed by agents with \[dev-work\]\(https:\/\/github\.com\/sebmartin\/dev-work\)\.\n\n<!-- dev-work:review round=1 -->$/)
  assert.doesNotMatch(r.body, /\*\*H\*\*/)   // the summary never repeats a finding
  assert.deepEqual([result.done, result.round, result.full_pass, result.open], [false, 1, true, { blocking: 0, should_fix: 1 }])
})

test('on someone else\'s PR the round is a pending draft that resolves nothing', async () => {
  const { result } = await run({ ...pr1, pr: { ...pr1.pr, author: 'stranger' } })
  assert.equal(result.review.event, 'PENDING'); assert.deepEqual(result.review.resolve, []); assert.deepEqual(result.review.unresolve, [])
})

test('a round with no findings is done in code\'s words and the agent adds nothing', async () => {
  const { result } = await run(pr1, { consolidator: () => ({ ...empty, note: 'AGENT-NOTE' }) })
  assert.equal(result.done, true); assert.match(result.review.body, /No further findings\. Review done\./); assert.doesNotMatch(result.review.body, /AGENT-NOTE/)
})

test('an agent note that reads like a status line is left out, so a later run never mistakes it for one', async () => {
  const { result } = await run(pr1, { consolidator: () => ({ ...empty, findings: [f()], note: 'Review done. Ship it.' }) })
  assert.doesNotMatch(result.review.body, /Ship it/)
})

test('blockers and should-fix findings are never filtered', async () => {
  const { result } = await run(pr1, { consolidator: () => ({ ...empty, findings: [f({ severity: 'blocker', post: false }), f({ severity: 'robustness', post: false, line: 4 })] }) })
  assert.equal(result.review.comments.length, 2)
})

test('a finding any source rated 🔴 or 🟠 is posted even when the consolidator downgrades it', async () => {
  const { result } = await run(pr1, { 'lens-correctness': () => ({ findings: [rawF({ severity: 'blocker' })] }), consolidator: () => ({ ...empty, findings: [f({ severity: 'cleanup', post: false, sources: ['correctness-1'] })] }) })
  assert.equal(result.review.comments.length, 1); assert.match(result.review.comments[0].body, /^🟡/)
})

test('a 🔴 or 🟠 source the consolidator leaves out is posted from the source as PLAUSIBLE', async () => {
  const { result } = await run(pr1, { 'lens-correctness': () => ({ findings: [rawF({ severity: 'blocker', headline: 'LOST' })] }) })
  assert.match(result.review.comments[0].body, /^🔴 \*\*LOST\*\*.*PLAUSIBLE/)
})

test('a refuted 🔴 needs file:line evidence to be dropped', async () => {
  const lens = { 'lens-correctness': () => ({ findings: [rawF({ severity: 'blocker' })] }) }
  const bare = await run(pr1, { ...lens, consolidator: () => ({ ...empty, refuted: [{ sources: ['correctness-1'], evidence: 'it is fine' }] }) })
  assert.equal(bare.result.review.comments.length, 1)
  const cited = await run(pr1, { ...lens, consolidator: () => ({ ...empty, refuted: [{ sources: ['correctness-1'], evidence: 'guarded at a.js:12' }] }) })
  assert.equal(cited.result.review.comments.length, 0)
})

test('a covered entry naming an unknown thread does not drop a blocker', async () => {
  const { result } = await run(pr1, { 'lens-correctness': () => ({ findings: [rawF({ severity: 'blocker' })] }), consolidator: () => ({ ...empty, covered: [{ sources: ['correctness-1'], thread: 'NOPE' }] }) })
  assert.equal(result.review.comments.length, 1)
})

test('a covered entry naming an existing thread drops the source finding', async () => {
  const { result } = await run({ ...pr1, threads: [thread('H1', 'what about nulls?', [])] }, { 'lens-correctness': () => ({ findings: [rawF({ severity: 'blocker' })] }), consolidator: () => ({ ...empty, covered: [{ sources: ['correctness-1'], thread: 'H1' }] }) })
  assert.equal(result.review.comments.length, 0)
})

test('each 🟡 is posted only when the consolidator weighs it worth posting, and a full pass counts what it left out', async () => {
  const { result } = await run(pr1, { consolidator: () => ({ ...empty, findings: [f({ severity: 'cleanup', post: true, sources: [] }), f({ severity: 'cleanup', post: false, sources: [], line: 5 }), f({ severity: 'cleanup', post: false, sources: [], line: 6 })] }) })
  assert.equal(result.review.comments.length, 1); assert.match(result.review.body, /2 minor points were left out\./)
})

test('there is no cap on findings', async () => {
  const many = Array.from({ length: 20 }, (_, i) => f({ severity: 'robustness', line: i + 1 }))
  const { result } = await run(pr1, { consolidator: () => ({ ...empty, findings: many }) })
  assert.equal(result.review.comments.length, 20)
})

test('a finding anchored outside the PR\'s files is posted file-level on the first changed file', async () => {
  const { result } = await run(pr1, { consolidator: () => ({ ...empty, findings: [f({ path: 'elsewhere.js', line: 9, location: 'elsewhere.js:9' })] }) })
  assert.deepEqual([result.review.comments[0].path, result.review.comments[0].line], ['a.js', 0])
  assert.match(result.review.comments[0].body, /`elsewhere\.js:9`/)
})

test('the consolidator\'s replies go only in human threads, each with the marker', async () => {
  const { result } = await run({ ...pr1, threads: [thread('H1', 'what about nulls?', [])] }, { consolidator: () => ({ ...empty, human_replies: [{ thread: 'H1', reply: 'Nulls are guarded at a.js:2.' }, { thread: 'NOPE', reply: 'x' }] }) })
  assert.deepEqual(result.review.replies, [{ thread: 'H1', body: 'Nulls are guarded at a.js:2.\n\n<!-- dev-work:review round=1 -->' }])
})

test('the security lens runs on opus when the scout flags an auth or untrusted-input surface', async () => {
  const hot = await run(pr1, { scout: () => ({ surfaces: [{ file: 'a.js', tags: ['untrusted_input'] }], lenses: ['security'], full_pass: false, reason: '' }) })
  assert.equal(hot.calls.find(c => c.label === 'lens-security').opts.model, 'opus')
  const cold = await run(pr1, { scout: () => ({ surfaces: [{ file: 'a.js', tags: ['persistence'] }], lenses: ['security'], full_pass: false, reason: '' }) })
  assert.equal(cold.calls.find(c => c.label === 'lens-security').opts.model, 'sonnet')
})

test('a lens that returns nothing fails the run at that lens', async () => {
  const { result } = await run(pr1, { 'lens-quality': () => null })
  assert.equal(result.status, 'failed'); assert.equal(result.stage, 'lens-quality')
})

test('the result reports output tokens from the budget', async () => {
  assert.equal((await run(pr1)).result.output_tokens, 4321)
})

test('the lenses see the diff range, the PR text and the design, and never a plan', async () => {
  const { prompt } = await run(pr1)
  for (const x of [`git diff ${sha('b')} ${sha('c')}`, 'PR-BODY', 'THE-DESIGN']) assert.ok(prompt('lens-correctness').includes(x), x)
  assert.doesNotMatch(prompt('lens-correctness'), /implementation-plan/)
})

test('codex runs beside the lenses in round 1 and its findings go to the consolidator', async () => {
  const { prompt, result } = await run(pr1, { codex: () => ({ exit_code: 0, output: JSON.stringify({ findings: [cx({ headline: 'CODEX-SAYS' })] }), stderr: '' }) })
  assert.match(prompt('consolidator'), /codex-1 \(.*codex\): CODEX-SAYS/); assert.deepEqual(result.codex, { ran: true, reason: null })
})
test('the codex runner is told the exact command, the prompt with the goal and design, and the schema', async () => {
  const { prompt, calls } = await run(pr1)
  for (const x of ['codex exec -s read-only --output-schema', ' -o ', GOAL_TEXT, 'THE-DESIGN', '"additionalProperties":false']) assert.ok(prompt('codex').includes(x), x)
  assert.ok(calls.find(c => c.label === 'codex').opts.schema.required.includes('exit_code'))
})
test('a PR body with code fences is fenced off by a longer fence in the codex runner prompt', async () => {
  const body = 'before\n```js\nx()\n````\nafter-fence'
  const { prompt } = await run({ ...pr1, pr: { ...pr1.pr, body } })
  const p = prompt('codex')
  const fences = p.split('\n').filter(l => /^`{5,}$/.test(l))
  assert.equal(fences.length, 2); assert.equal(fences[0], fences[1])
  const inner = p.slice(p.indexOf(fences[0]) + fences[0].length, p.lastIndexOf(fences[1]))
  assert.ok(inner.includes(body)); assert.ok(!inner.includes(fences[0]))
})
test('every way codex can fail leaves the same lenses and a complete review, with the reason', async () => {
  const cases = [
    [{ ...pr1, codex: { available: false, reason: 'not signed in' } }, {}, /not signed in/],
    [pr1, { codex: () => null }, /returned nothing/],
    [pr1, { codex: () => { throw new Error('boom') } }, /returned nothing/],
    [pr1, { codex: () => ({ exit_code: 1, output: '', stderr: 'You have hit your usage limit' }) }, /status 1.*usage limit/],
    [pr1, { codex: () => ({ exit_code: 0, output: '', stderr: '' }) }, /empty/],
    [pr1, { codex: () => ({ exit_code: 0, output: '{"findings":[{"file":"a.js"', stderr: '' }) }, /not JSON/],
  ]
  for (const [args, over, why] of cases) {
    const { result, calls } = await run(args, over)
    assert.equal(result.status, 'done'); assert.equal(result.codex.ran, false); assert.match(result.codex.reason, why)
    assert.deepEqual(calls.filter(c => c.label.startsWith('lens-')).map(c => c.label).sort(), ['lens-correctness', 'lens-intent', 'lens-quality'])
  }
})
test('codex output that is valid JSON but missing required finding fields contributes nothing', async () => {
  const { result, prompt } = await run(pr1, { codex: () => ({ exit_code: 0, output: JSON.stringify({ findings: [{ file: 'a.js', headline: 'half' }] }), stderr: '' }) })
  assert.equal(result.codex.ran, false); assert.match(result.codex.reason, /schema/); assert.doesNotMatch(prompt('consolidator'), /half/)
})
test('codex that is unavailable never starts its runner', async () => {
  const { calls } = await run({ ...pr1, codex: { available: false, reason: 'not installed' } })
  assert.ok(!calls.some(c => c.label === 'codex'))
})
