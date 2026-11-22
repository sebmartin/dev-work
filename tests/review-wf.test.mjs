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
const defaults = {
  scout: () => ({ verdict: 'normal' }),
}
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
