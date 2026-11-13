// Runs workflows/execute.js with stand-in agents, so its control flow, its prompts and its result can be
// checked without starting a model. Run with: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SCRIPT = readFileSync(new URL('../workflows/execute.js', import.meta.url), 'utf8')
  .replace(/^export const meta/m, 'const meta')

const sha = c => c.repeat(40)
const BASE = sha('e')

// What each agent returns, by label, unless a test overrides it. Every re-review closes what it was given,
// with evidence; every review is clean except where a test says otherwise.
const defaults = {
  plan: () => ({ overview: 'OVERVIEW', global_constraints: 'GC', review_focus: 'RF', assumptions: ['an assumption'], follow_ups: ['a follow-up'],
    tasks: [{ n: 1, title: 'one', text: 'TASK ONE' }, { n: 2, title: 'two', text: 'TASK TWO' }] }),
  'pre-flight': () => ({ scan: ['row'], task_models: [{ task: 1, model: 'sonnet' }, { task: 2, model: 'haiku' }], rulings: ['Ruling: PREFLIGHT-RULING; why: w; cost if wrong: c'], stop: false, stop_reason: '' }),
  implement: (p, label) => ({ status: 'DONE', head_sha: label === 'implement-1' ? sha('a') : sha('b'), summary: 'ok', report: `REPORT-OF-${label}`, red: `RED-OF-${label}` }),
  review: () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved', findings: [] }),
  verify: () => ({ gaps: [] }),
  fix: () => ({ status: 'DONE', head_sha: sha('c'), summary: 'fixed', report: 'FIX-REPORT', red: 'not applicable: fix' }),
  're-review': p => ({ results: [...p.matchAll(/^- ([A-Z0-9][\w-]*) \(/gm)].map(m => ({ id: m[1], addressed: true, evidence: 'x.js:1' })), new_findings: [], out_of_scope: [] }),
  'final-review': () => ({ summary: 'FINAL-SUMMARY', declined: [], ready: 'Yes', findings: [] }),
  'deferral-check': p => ({ items: [...p.matchAll(/^- (D-\d+) \(/gm)].map(m => ({ id: m[1], consequence: 'nothing goes wrong', verdict: 'defer', needs_design_change: false, reason: 'harmless' })) }),
  'write-up': () => ({ title: 'PR-TITLE', body: 'PR-BODY' }),
  'round-1-write-up': p => ({ replies: [...p.matchAll(/^- (PR[\w-]+): /gm)].map(m => ({ id: m[1], reply: 'done' })), pr_body: '' }),
}
const kind = label =>
  label.startsWith('implement-') ? 'implement'
    : /^review-\d/.test(label) ? 'review'
      : label.startsWith('verify-') ? 'verify'
        : /-re-review(-|$)/.test(label) ? 're-review'
          : /-fix(-|$)/.test(label) ? 'fix'
            : label

async function run(args, overrides = {}) {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt, opts })
    const respond = overrides[opts.label] || overrides[kind(opts.label)] || defaults[opts.label] || defaults[kind(opts.label)]
    if (!respond) throw new Error(`no stand-in for agent ${opts.label}`)
    return respond(prompt, opts.label, calls)
  }
  const context = vm.createContext({ args, agent, phase: () => {}, log: () => {} })
  const result = await vm.runInContext(`(async () => {\n${SCRIPT}\n})()`, context)
  // The result comes from another realm; a JSON round trip makes it plain data for the assertions.
  return { result: JSON.parse(JSON.stringify(result)), calls, prompt: label => (calls.find(c => c.label === label) || {}).prompt }
}

const start = { design: 'THE-DESIGN', inputs: [{ name: 'cases.json', description: 'test cases' }], pr_template: 'THE-TEMPLATE', base: BASE }

test('a start runs every stage to done and returns what develop reads', async () => {
  const { result, calls } = await run(start)
  assert.equal(result.status, 'done')
  for (const key of ['final_head', 'plan', 'pr_title', 'pr_body', 'follow_ups', 'rulings', 'parked', 'deferred', 'surfaced', 'tasks']) assert.ok(key in result, `result has ${key}`)
  assert.equal(result.pr_title, 'PR-TITLE')
  assert.deepEqual(calls.map(c => c.label), ['plan', 'pre-flight', 'implement-1', 'review-1', 'implement-2', 'review-2', 'final-review', 'write-up'])
})

test('every agent runs as a dev-work worker', async () => {
  const { calls } = await run(start)
  for (const c of calls) assert.equal(c.opts.agentType, 'dev-work:worker', c.label)
})

test('prompts carry the rulings, the staged inputs, and the implementer report and failing run', async () => {
  const { prompt } = await run(start)
  assert.match(prompt('implement-2'), /PREFLIGHT-RULING/)
  assert.match(prompt('implement-1'), /\.dev-work\/inputs\/cases\.json/)
  assert.match(prompt('review-1'), /REPORT-OF-implement-1/)
  assert.match(prompt('review-1'), /RED-OF-implement-1/)
  assert.match(prompt('write-up'), /THE-TEMPLATE/)
})

test('the planner writes the plan to .dev-work/implementation-plan.md', async () => {
  const { prompt } = await run(start)
  assert.match(prompt('plan'), /\.dev-work\/implementation-plan\.md/)
})

const oneFinding = { 'review-1': () => ({ spec_verdict: 'fail', cannot_verify: [], quality_verdict: 'Needs fixes', findings: [{ id: 'T1-1', severity: 'Important', text: 'broken' }] }) }

test('a review finding gets a fix round and a re-review', async () => {
  const { calls, result } = await run(start, oneFinding)
  const labels = calls.map(c => c.label)
  assert.ok(labels.includes('task-1-fix-r1') && labels.includes('task-1-re-review-r1'))
  assert.equal(result.tasks[0].rounds, 1)
})

test('a finding marked addressed without evidence stays open', async () => {
  const noEvidence = { 're-review': p => ({ results: [...p.matchAll(/^- ([A-Z0-9][\w-]*) \(/gm)].map(m => ({ id: m[1], addressed: true, evidence: '' })), new_findings: [], out_of_scope: [] }),
    'breaker-1': () => ({ decisions: [{ id: 'T1-1', decision: 'park', ruling: 'parked' }], rulings: [], stop: false, stop_reason: '' }) }
  const { calls } = await run(start, { ...oneFinding, ...noEvidence })
  const labels = calls.map(c => c.label)
  assert.ok(labels.includes('task-1-fix-r2'), 'a second fix round runs')
  assert.ok(labels.includes('breaker-1'), 'the breaker rules on it after the cap')
})

test('the deferral check fixes real harm before the write-up', async () => {
  const minor = { 'review-1': () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved', findings: [{ id: 'T1-1', severity: 'Minor', text: 'loses data' }] }),
    'deferral-check': () => ({ items: [{ id: 'D-1', consequence: 'content is lost', verdict: 'resolve', needs_design_change: false, reason: '' }] }) }
  const { calls, result } = await run(start, minor)
  const labels = calls.map(c => c.label)
  assert.ok(labels.indexOf('deferral-fix') > labels.indexOf('deferral-check'))
  assert.ok(labels.indexOf('write-up') > labels.indexOf('deferral-re-review'))
  assert.equal(result.status, 'done')
  assert.deepEqual(result.deferred, [])
})

test('a finding the deferral check skips is treated as needing a fix', async () => {
  const minor = { 'review-1': () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved', findings: [{ id: 'T1-1', severity: 'Minor', text: 'x' }] }),
    'deferral-check': () => ({ items: [] }) }
  const { calls } = await run(start, minor)
  assert.ok(calls.some(c => c.label === 'deferral-fix'))
})

test('a deferred finding keeps the reason it was left out', async () => {
  const minor = { 'review-1': () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved', findings: [{ id: 'T1-1', severity: 'Minor', text: 'a nit' }] }) }
  const { result } = await run(start, minor)
  assert.equal(result.deferred.length, 1)
  assert.match(result.deferred[0], /a nit.*left out because: harmless/)
})

test('a design question at the deferral check stops with kind design', async () => {
  const minor = { 'review-1': () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved', findings: [{ id: 'T1-1', severity: 'Minor', text: 'x' }] }),
    'deferral-check': () => ({ items: [{ id: 'D-1', consequence: 'wrong behaviour', verdict: 'resolve', needs_design_change: true, reason: '' }] }) }
  const { result } = await run(start, minor)
  assert.equal(result.status, 'stopped')
  assert.equal(result.kind, 'design')
})

test('the ruler stopping at pre-flight stops with kind ruler', async () => {
  const { result, calls } = await run(start, { 'pre-flight': () => ({ scan: [], task_models: [], rulings: [], stop: true, stop_reason: 'broken plan' }) })
  assert.equal(result.status, 'stopped')
  assert.equal(result.kind, 'ruler')
  assert.ok(!calls.some(c => c.label.startsWith('implement-')))
})

test('an implementer still blocked after three dispatches stops with kind blocked', async () => {
  const blocked = { implement: (p, label) => ({ status: 'BLOCKED', head_sha: BASE, summary: 'stuck', report: 'stuck', red: 'not applicable: blocked' }),
    'rule-1-a1': () => ({ answer: 'try again', escalate: false, rulings: [], stop: false, stop_reason: '' }),
    'rule-1-a2': () => ({ answer: 'try again', escalate: false, rulings: [], stop: false, stop_reason: '' }) }
  const { result } = await run(start, blocked)
  assert.equal(result.status, 'stopped')
  assert.equal(result.kind, 'blocked')
})

const round = { ...start, feedback: [{ id: 'PR1-1', text: 'rename x' }], round: 1, pr: 'THE-PR-TEXT', head: sha('f') }

test('a review round fixes, re-reviews and writes replies without replanning', async () => {
  const { result, calls, prompt } = await run(round)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.replies, [{ id: 'PR1-1', reply: 'done' }])
  assert.ok(!calls.some(c => c.label === 'plan'))
  assert.match(prompt('round-1-fix-r1'), /THE-PR-TEXT/)
  assert.match(prompt('round-1-re-review-r1'), new RegExp(sha('f')))
})
