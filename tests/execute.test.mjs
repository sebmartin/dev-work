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
  'pre-flight': () => ({ scan: ['row'], task_models: [{ task: 1, model: 'sonnet' }, { task: 2, model: 'haiku' }], rulings: ['Ruling: PREFLIGHT-RULING; why: w; cost if wrong: c'] }),
  implement: (p, label) => ({ status: 'DONE', head_sha: label === 'implement-1' ? sha('a') : sha('b'), summary: 'ok', report: `REPORT-OF-${label}`, red: `RED-OF-${label}` }),
  review: () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved', findings: [] }),
  verify: () => ({ gaps: [] }),
  fix: () => ({ status: 'DONE', head_sha: sha('c'), summary: 'fixed', report: 'FIX-REPORT', red: 'not applicable: fix' }),
  're-review': p => ({ results: [...p.matchAll(/^- ([A-Z0-9][\w-]*) \(/gm)].map(m => ({ id: m[1], addressed: true, evidence: 'x.js:1' })), new_findings: [], out_of_scope: [] }),
  'final-review': () => ({ summary: 'FINAL-SUMMARY', declined: [], ready: 'Yes', findings: [] }),
  'deferral-check': p => ({ items: [...p.matchAll(/^- (D-\d+) \(/gm)].map(m => ({ id: m[1], consequence: 'nothing goes wrong', verdict: 'defer', needs_user: false, reason: 'harmless' })) }),
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

test('a failed run returns the plan, each task\'s outcome, the rulings and the findings', async () => {
  const { result } = await run(start, { 'review-2': () => null })
  assert.equal(result.status, 'failed')
  assert.equal(result.stage, 'review 2')
  assert.equal(result.head, sha('b'))
  assert.match(result.plan, /TASK TWO/)
  assert.deepEqual(result.tasks.map(t => [t.task, t.state]), [[1, 'done'], [2, 'in progress']])
  assert.equal(result.tasks[1].commits, `${sha('a').slice(0, 7)}..${sha('b').slice(0, 7)}`)
  assert.match(result.rulings.join('\n'), /PREFLIGHT-RULING/)
  for (const key of ['deferred', 'parked', 'verdicts']) assert.ok(Array.isArray(result[key]), key)
})

test('an agent that throws ends the run with a failed result that keeps its state', async () => {
  const { result } = await run(start, { 'implement-2': () => { throw new Error('usage limit reached') } })
  assert.equal(result.status, 'failed')
  assert.equal(result.stage, 'implement-2')
  assert.match(result.error, /usage limit reached/)
  assert.deepEqual(result.tasks.map(t => t.state), ['done', 'in progress'])
})

const oneFinding = { 'review-1': () => ({ spec_verdict: 'fail', cannot_verify: [], quality_verdict: 'Needs fixes', findings: [{ id: 'T1-1', severity: 'Important', text: 'broken', consequence: 'users lose drafts' }] }) }

test('task review findings must carry a consequence', async () => {
  const { calls, prompt } = await run(start)
  const review = calls.find(c => c.label === 'review-1')
  assert.ok(review.opts.schema.properties.findings.items.required.includes('consequence'))
  assert.match(prompt('review-1'), /what actually goes wrong, and for whom/)
  assert.match(prompt('review-1'), /never Minor/)
})

test('a fix round sees what goes wrong for each finding', async () => {
  const { prompt } = await run(start, oneFinding)
  assert.match(prompt('task-1-fix-r1'), /What goes wrong: users lose drafts/)
  assert.match(prompt('task-1-fix-r1'), /can't be fixed without changing the design/)
})

test('a review finding gets a fix round and a re-review', async () => {
  const { calls, result } = await run(start, oneFinding)
  const labels = calls.map(c => c.label)
  assert.ok(labels.includes('task-1-fix-r1') && labels.includes('task-1-re-review-r1'))
  assert.equal(result.tasks[0].rounds, 1)
})

test('a finding marked addressed without evidence stays open', async () => {
  const noEvidence = { 're-review': p => ({ results: [...p.matchAll(/^- ([A-Z0-9][\w-]*) \(/gm)].map(m => ({ id: m[1], addressed: true, evidence: '' })), new_findings: [], out_of_scope: [] }),
    'breaker-1': () => ({ decisions: [{ id: 'T1-1', decision: 'park', ruling: 'parked' }], rulings: [] }) }
  const { calls } = await run(start, { ...oneFinding, ...noEvidence })
  const labels = calls.map(c => c.label)
  assert.ok(labels.includes('task-1-fix-r2'), 'a second fix round runs')
  assert.ok(labels.includes('breaker-1'), 'the breaker rules on it after the cap')
})

test('the deferral check fixes real harm before the write-up', async () => {
  const minor = { 'review-1': () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved', findings: [{ id: 'T1-1', severity: 'Minor', text: 'loses data' }] }),
    'deferral-check': () => ({ items: [{ id: 'D-1', consequence: 'content is lost', verdict: 'resolve', needs_user: false, reason: '' }] }) }
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

test('a design question at the deferral check pauses', async () => {
  const minor = { 'review-1': () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved', findings: [{ id: 'T1-1', severity: 'Minor', text: 'x' }] }),
    'deferral-check': () => ({ items: [{ id: 'D-1', consequence: 'wrong behaviour', verdict: 'resolve', needs_user: true, reason: '' }] }) }
  const { result, calls } = await run(start, minor)
  assert.equal(result.status, 'paused')
  assert.equal(result.at, 'deferral check')
  assert.ok(!calls.some(c => c.label === 'write-up'))
})

const asking = { question: 'Keep the old flag?', reason: 'expensive to reverse', why: 'w', if_guessed: 'users lose settings', options: ['keep', 'drop'], recommendation: 'keep' }
const blocked = (p, label) => ({ status: 'BLOCKED', head_sha: sha('b'), summary: 'stuck', report: 'stuck', red: 'not applicable: blocked' })

test('a ruler question at a task pauses the run and keeps everything done so far', async () => {
  const { result, calls } = await run(start, { 'implement-2': blocked,
    'rule-2-a1': () => ({ answer: '', escalate: false, rulings: ['Ruling: R2; why: w; cost if wrong: c'], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.deepEqual(result.question, asking)
  assert.equal(result.at, 'task 2')
  assert.equal(result.head, sha('b'))
  assert.deepEqual(result.tasks.map(t => t.state), ['done', 'in progress'])
  assert.match(result.rulings.join('\n'), /PREFLIGHT-RULING[\s\S]*R2/)
  assert.ok(!calls.some(c => ['final-review', 'write-up'].includes(c.label)))
})

test('the ruler asking at pre-flight pauses before any task is built', async () => {
  const { result, calls } = await run(start, { 'pre-flight': () => ({ scan: [], task_models: [], rulings: [], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.equal(result.at, 'pre-flight')
  assert.deepEqual(result.tasks.map(t => t.state), ['not started', 'not started'])
  assert.ok(!calls.some(c => c.label.startsWith('implement-')))
})

test('the ruler offers a question instead of a stop', async () => {
  const { calls, prompt } = await run(start)
  const schema = calls.find(c => c.label === 'pre-flight').opts.schema
  assert.ok('question' in schema.properties && !('stop' in schema.properties))
  assert.match(prompt('pre-flight'), /expensive to reverse/)
  assert.match(prompt('pre-flight'), /scope creep/)
})

test('an implementer still blocked after three dispatches produces a question', async () => {
  const again = () => ({ answer: 'try again', escalate: false, rulings: [] })
  const { result, calls } = await run(start, { implement: blocked, 'rule-1-a1': again, 'rule-1-a2': again, 'ask-1': () => ({ rulings: [], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.deepEqual(result.question, asking)
  assert.ok(calls.some(c => c.label === 'ask-1'))
})

test('an implementer still blocked with no question from the ruler still pauses', async () => {
  const again = () => ({ answer: 'try again', escalate: false, rulings: [] })
  const { result } = await run(start, { implement: blocked, 'rule-1-a1': again, 'rule-1-a2': again, 'ask-1': () => ({ rulings: [] }) })
  assert.equal(result.status, 'paused')
  assert.match(result.question.question, /Task 1/)
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

test('the re-review asks for a consequence on new findings', async () => {
  const { prompt } = await run(start, oneFinding)
  assert.match(prompt('task-1-re-review-r1'), /write the answer in consequence/)
  assert.match(prompt('task-1-re-review-r1'), /never Minor/)
})

test('a failed review round returns well-formed state', async () => {
  const { result } = await run(round, { 'round-1-write-up': () => null })
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.tasks, [])
})

test('a question in a review round pauses it with the round and its feedback', async () => {
  const { result, calls } = await run(round, {
    're-review': () => ({ results: [], new_findings: [], out_of_scope: [] }),
    'round-breaker': () => ({ decisions: [], rulings: [], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.equal(result.round, 1)
  assert.deepEqual(result.feedback, round.feedback)
  assert.ok(!calls.some(c => c.label === 'round-1-write-up'))
})

const twoMinor = { 'review-1': () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved',
  findings: [{ id: 'T1-1', severity: 'Minor', text: 'typo in log', consequence: 'c' }, { id: 'T1-2', severity: 'Minor', text: 'flag missing', consequence: 'c' }] }) }

test('the deferral check fixes the other harmful findings, then pauses on the one that needs the user', async () => {
  const { result, calls, prompt } = await run(start, { ...twoMinor, 'deferral-check': () => ({ items: [
    { id: 'D-1', consequence: 'logs mislead', verdict: 'resolve', needs_user: false, reason: 'cheap' },
    { id: 'D-2', consequence: 'items stuck', verdict: 'resolve', needs_user: true, reason: 'grows scope' }], question: asking }) })
  const labels = calls.map(c => c.label)
  assert.ok(labels.indexOf('deferral-check') < labels.indexOf('deferral-fix') && labels.indexOf('deferral-fix') < labels.indexOf('deferral-re-review'))
  assert.match(prompt('deferral-fix'), /typo in log/)
  assert.doesNotMatch(prompt('deferral-fix'), /flag missing/)
  assert.ok(!labels.includes('write-up'))
  assert.equal(result.status, 'paused')
  assert.equal(result.at, 'deferral check')
  assert.deepEqual(result.question, asking)
  assert.equal(result.head, sha('c'))
  assert.deepEqual(result.verdicts.map(v => [v.id, v.verdict, v.needs_user, v.reason]), [['D-1', 'resolve', false, 'cheap'], ['D-2', 'resolve', true, 'grows scope']])
  assert.match(result.deferred.join('\n'), /flag missing.*needs the user's decision: items stuck/)
})

test('a failure in the deferral fix or re-review keeps the finding to be fixed in the result', async () => {
  const check = () => ({ items: [{ id: 'D-1', consequence: 'logs mislead', verdict: 'resolve', needs_user: false, reason: '' }, { id: 'D-2', consequence: 'none', verdict: 'defer', needs_user: false, reason: 'harmless' }] })
  for (const fail of [{ 'deferral-fix': () => { throw new Error('usage limit reached') } }, { 'deferral-fix': () => null }, { 'deferral-re-review': () => null }]) {
    const { result } = await run(start, { ...twoMinor, 'deferral-check': check, ...fail })
    assert.equal(result.status, 'failed')
    assert.match(result.deferred.join('\n'), /typo in log.*fix pending/)
    assert.match(result.deferred.join('\n'), /flag missing.*left out because/)
  }
})

test('a finding that needs the user with no question from the check still pauses', async () => {
  const { result } = await run(start, { ...twoMinor, 'deferral-check': () => ({ items: [
    { id: 'D-1', consequence: 'none', verdict: 'defer', needs_user: false, reason: 'harmless' },
    { id: 'D-2', consequence: 'items stuck', verdict: 'resolve', needs_user: true, reason: '' }] }) })
  assert.equal(result.status, 'paused')
  assert.match(result.question.question, /flag missing/)
})

test('a finding still open after the deferral fix pauses the run', async () => {
  const { result, calls } = await run(start, { ...twoMinor,
    'deferral-check': () => ({ items: [{ id: 'D-1', consequence: 'logs mislead', verdict: 'resolve', needs_user: false, reason: '' }, { id: 'D-2', consequence: 'none', verdict: 'defer', needs_user: false, reason: 'harmless' }] }),
    'deferral-re-review': () => ({ results: [{ id: 'D-1', addressed: false, evidence: '' }], new_findings: [], out_of_scope: [] }) })
  assert.equal(result.status, 'paused')
  assert.ok(!calls.some(c => c.label === 'write-up'))
})

test('the deferral check prompt asks when the user must decide', async () => {
  const { prompt } = await run(start, twoMinor)
  assert.match(prompt('deferral-check'), /needs_user/)
  assert.match(prompt('deferral-check'), /scope creep/)
})

const replanArgs = { ...start, replan: { source: 'paused', plan: 'OLD-PLAN', tasks: [{ task: 1, title: 'one', state: 'done', commits: 'aaaaaaa..bbbbbbb' }],
  rulings: ['Ruling: OLD; why: w; cost if wrong: c'], deferred: ['OLD-DEFERRED'], parked: [], decision: 'THE-DECISION', head: sha('d') } }
const replanned = () => ({ overview: 'OVERVIEW', global_constraints: 'GC', review_focus: 'RF', assumptions: [], follow_ups: [], tasks: [
  { n: 1, title: 'one', text: 'TASK ONE', disposition: 'kept', reason: 'still right', from: 1 },
  { n: 2, title: 'two', text: 'TASK TWO', disposition: 'revised', reason: 'flag changes' },
  { n: 3, title: 'three', text: 'TASK THREE', disposition: 'new', reason: 'the decision' },
  { n: 4, title: 'four', text: 'TASK FOUR', disposition: 'dropped', reason: 'no longer wanted' }] })

test('re-plan mode skips kept tasks and builds revised and new ones', async () => {
  const { result, calls, prompt } = await run(replanArgs, { plan: replanned })
  const labels = calls.map(c => c.label)
  assert.ok(labels.includes('implement-2') && labels.includes('implement-3'))
  assert.ok(!labels.includes('implement-1') && !labels.includes('implement-4'))
  assert.match(prompt('review-2'), new RegExp(`Base: ${sha('d')}`))
  assert.match(prompt('final-review'), new RegExp(`Base: ${BASE}`))
  assert.match(prompt('final-review'), /OLD-DEFERRED/)
  assert.match(prompt('implement-2'), /being revised/)
  assert.deepEqual(result.replan_counts, { kept: 1, revised: 1, new: 1, dropped: 1 })
  assert.deepEqual(result.tasks.map(t => t.state), ['kept', 'done', 'done', 'dropped'])
  assert.equal(result.status, 'done')
})

test('the re-planner gets the old plan, the outcomes, the rulings, the decision and the findings', async () => {
  const { prompt, calls } = await run(replanArgs, { plan: replanned })
  for (const x of ['OLD-PLAN', 'aaaaaaa..bbbbbbb', 'Ruling: OLD', 'THE-DECISION', 'OLD-DEFERRED', 'turned out to be missing something', 'reused by default']) assert.ok(prompt('plan').includes(x), x)
  assert.ok(calls.find(c => c.label === 'plan').opts.schema.properties.tasks.items.required.includes('disposition'))
  assert.match(prompt('implement-2'), /Ruling: OLD/)
})

test('a ruling the pre-flight withdraws is not carried', async () => {
  const { prompt } = await run(replanArgs, { plan: replanned,
    'pre-flight': () => ({ scan: [], task_models: [], rulings: [], withdrawn: ['Ruling: OLD; why: w; cost if wrong: c'] }) })
  assert.doesNotMatch(prompt('implement-2'), /Ruling: OLD/)
})

test('a withdrawn ruling is matched whole, not as a substring of other carried rulings', async () => {
  const args = { ...replanArgs, replan: { ...replanArgs.replan, rulings: ['Ruling: OLD; why: w; cost if wrong: c', 'Ruling: OLD; why: other; cost if wrong: c'] } }
  const { prompt } = await run(args, { plan: replanned,
    'pre-flight': () => ({ scan: [], task_models: [], rulings: [], withdrawn: ['Ruling: OLD', 'Before the re-plan: Ruling: OLD; why: w; cost if wrong: c'] }) })
  assert.match(prompt('implement-2'), /why: other/)
  assert.doesNotMatch(prompt('implement-2'), /why: w;/)
})

test('a re-plan after a failed re-plan still shows the planner the decision that caused it', async () => {
  const { prompt } = await run({ ...replanArgs, replan: { ...replanArgs.replan, source: 'failed' } }, { plan: replanned })
  assert.match(prompt('plan'), /THE-DECISION/)
  assert.match(prompt('plan'), /operational reason/)
})

test('a re-plan from the saved plan alone treats every task as unverified', async () => {
  const { prompt } = await run({ ...start, replan: { source: 'saved-plan', plan: 'OLD-PLAN', tasks: [], rulings: [], deferred: [], parked: [], decision: '', head: sha('d') } }, { plan: replanned })
  assert.match(prompt('plan'), /unverified/)
})

test('a re-plan that pauses before building still reports its kept and dropped tasks', async () => {
  const { result } = await run(replanArgs, { plan: replanned, 'pre-flight': () => ({ scan: [], task_models: [], rulings: [], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.deepEqual(result.tasks.map(t => t.state), ['kept', 'not started', 'not started', 'dropped'])
  assert.equal(result.tasks[0].reason, 'still right')
  assert.deepEqual(result.replan_counts, { kept: 1, revised: 1, new: 1, dropped: 1 })
})

test('a re-planned task with no disposition is built', async () => {
  const { calls, result } = await run(replanArgs)
  assert.ok(calls.some(c => c.label === 'implement-1') && calls.some(c => c.label === 'implement-2'))
  assert.deepEqual(result.replan_counts, { kept: 0, revised: 0, new: 2, dropped: 0 })
})

test('a re-plan without a valid head fails before planning', async () => {
  for (const head of [undefined, '', 'HEAD', sha('d').slice(0, 7)]) {
    const { result, calls } = await run({ ...replanArgs, replan: { ...replanArgs.replan, head } })
    assert.equal(calls.length, 0, String(head))
    assert.equal(result.status, 'failed')
    assert.equal(result.stage, 're-plan')
    assert.match(result.error, /head/)
    assert.equal(result.head, BASE)
    assert.deepEqual(result.tasks, [])
  }
})

const noEvidenceRe = { 're-review': p => ({ results: [...p.matchAll(/^- ([A-Z0-9][\w-]*) \(/gm)].map(m => ({ id: m[1], addressed: true, evidence: '' })), new_findings: [], out_of_scope: [] }) }

test('a question from the task breaker parks the findings still open', async () => {
  const { result } = await run(start, { ...oneFinding, ...noEvidenceRe, 'breaker-1': () => ({ decisions: [], rulings: [], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.match(result.parked.join('\n'), /T1 T1-1: .*open when the run paused/)
})

test('a question from the final breaker parks the findings still open', async () => {
  const { result } = await run(start, { ...noEvidenceRe,
    'final-review': () => ({ summary: 's', declined: [], ready: 'No', findings: [{ id: 'F-1', severity: 'Important', text: 'broken thing' }] }),
    'final-breaker': () => ({ decisions: [], rulings: [], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.match(result.parked.join('\n'), /final F-1: broken thing.*open when the run paused/)
})

test('a question from the plan-mandated ruling parks the findings open at that task', async () => {
  const { result } = await run(start, {
    'review-1': () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved', findings: [{ id: 'T1-1', severity: 'Important', text: 'mandated gap', plan_mandated: true, consequence: 'c' }] }),
    'resolve-1': () => ({ keep: [], rulings: [], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.match(result.parked.join('\n'), /T1 T1-1: mandated gap.*open when the run paused/)
})

test('a question from the round breaker parks the findings still open', async () => {
  const { result } = await run(round, {
    're-review': () => ({ results: [], new_findings: [], out_of_scope: [] }),
    'round-breaker': () => ({ decisions: [], rulings: [], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.match(result.parked.join('\n'), /round 1 PR1-1: rename x.*open when the run paused/)
})

test('findings the final breaker surfaced are parked when the deferral check then pauses', async () => {
  const { result } = await run(start, { ...noEvidenceRe,
    'final-review': () => ({ summary: 's', declined: ['set aside'], ready: 'No', findings: [{ id: 'F-1', severity: 'Important', text: 'load-bearing thing' }] }),
    'final-breaker': () => ({ decisions: [{ id: 'F-1', decision: 'surface', ruling: 'a human must look' }], rulings: [] }),
    'deferral-check': () => ({ items: [{ id: 'D-1', consequence: 'harm', verdict: 'resolve', needs_user: true, reason: '' }], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.match(result.parked.join('\n'), /F-1: load-bearing thing.*surfaced for a human; open when the run paused/)
})

test('findings the round breaker surfaced are parked when the round deferral check then pauses', async () => {
  const { result } = await run(round, {
    're-review': () => ({ results: [], new_findings: [], out_of_scope: ['an aside'] }),
    'round-breaker': () => ({ decisions: [{ id: 'PR1-1', decision: 'surface', ruling: 'a human must look' }], rulings: [] }),
    'deferral-check': () => ({ items: [{ id: 'D-1', consequence: 'harm', verdict: 'resolve', needs_user: true, reason: '' }], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.match(result.parked.join('\n'), /PR1-1: rename x.*surfaced for a human; open when the run paused/)
})

const importantInTwo = { 'review-2': () => ({ spec_verdict: 'fail', cannot_verify: [], quality_verdict: 'Needs fixes', findings: [{ id: 'T2-1', severity: 'Important', text: 'rejected code', consequence: 'users lose drafts' }] }) }

test('a failed result shows the task in hand with its review and keeps its open findings', async () => {
  for (const fail of [{ 'task-2-fix-r1': () => { throw new Error('usage limit reached') } }, { 'task-2-fix-r1': () => null }, { 'task-2-re-review-r1': () => null }]) {
    const { result } = await run(start, { ...importantInTwo, ...fail })
    assert.equal(result.status, 'failed')
    assert.equal(result.tasks[1].state, 'in progress')
    assert.match(result.tasks[1].review, /fail, Needs fixes; 1 finding\(s\) open/)
    assert.match(result.parked.join('\n'), /T2 T2-1: rejected code.*users lose drafts.*open when the run failed/)
  }
})

test('a task that fails before its review is shown as not reviewed', async () => {
  const { result } = await run(start, { 'review-2': () => null })
  assert.equal(result.tasks[1].review, 'not reviewed yet')
})

test('the re-planner is told an in-progress task has not passed review', async () => {
  const { prompt } = await run(replanArgs, { plan: replanned })
  assert.match(prompt('plan'), /has not passed review/)
})

test('the reviewer of a revised task is told it is a revision and to use cannot_verify', async () => {
  const { prompt } = await run(replanArgs, { plan: replanned })
  assert.match(prompt('review-2'), /being revised \(flag changes\)/)
  assert.match(prompt('review-2'), /already on the branch before Base[\s\S]*cannot_verify/)
  assert.doesNotMatch(prompt('review-3'), /being revised/)
})

test('a line the final review set aside reaches the deferral check and a resolve verdict on it is fixed', async () => {
  const { result, calls, prompt } = await run(start, {
    'final-review': () => ({ summary: 's', declined: ['out-of-scope defect'], ready: 'Yes', findings: [] }),
    'deferral-check': () => ({ items: [{ id: 'D-1', consequence: 'content is lost', verdict: 'resolve', needs_user: false, reason: '' }] }) })
  const labels = calls.map(c => c.label)
  assert.match(prompt('deferral-check'), /D-1 \(declined\): out-of-scope defect/)
  assert.match(prompt('deferral-fix'), /out-of-scope defect/)
  assert.ok(labels.indexOf('write-up') > labels.indexOf('deferral-re-review'))
  assert.equal(result.status, 'done')
  assert.deepEqual(result.declined, [])
})

test('a set-aside line the deferral check defers keeps its reason in the write-up', async () => {
  const { prompt } = await run(start, { 'final-review': () => ({ summary: 's', declined: ['a design choice'], ready: 'Yes', findings: [] }) })
  assert.match(prompt('write-up'), /a design choice \(left out because: harmless\)/)
})

test('a set-aside line that needs the user is kept in the paused result', async () => {
  const { result } = await run(start, {
    'final-review': () => ({ summary: 's', declined: ['out-of-scope defect'], ready: 'Yes', findings: [] }),
    'deferral-check': () => ({ items: [{ id: 'D-1', consequence: 'harm', verdict: 'resolve', needs_user: true, reason: '' }], question: asking }) })
  assert.equal(result.status, 'paused')
  assert.match(result.declined.join('\n'), /out-of-scope defect.*needs the user's decision/)
})

test('the final review runs on Opus at xhigh and both it and the deferral check must trace what a change removes', async () => {
  const { calls, prompt } = await run(start, { 'review-1': () => ({ spec_verdict: 'pass', cannot_verify: [], quality_verdict: 'Approved', findings: [{ id: 'T1-1', severity: 'Minor', text: 'x', consequence: 'c' }] }) })
  const fr = calls.find(c => c.label === 'final-review')
  assert.equal(fr.opts.model, 'opus')
  assert.equal(fr.opts.effort, 'xhigh')
  const trace = /Before you rate a finding Minor or call it harmless, and for anything the change removes, moves or recreates \(a file, a directory, a worktree, saved state\), trace what later reads or relies on it, in this change and in the code around it\. Ask what breaks because it is gone, not only whether anything is lost\./
  assert.match(prompt('final-review'), trace)
  assert.match(prompt('deferral-check'), trace)
  for (const l of ['review-1', 'implement-1']) assert.doesNotMatch(prompt(l), trace)
  assert.notEqual(calls.find(c => c.label === 'review-1').opts.effort, 'xhigh')
})

test('an implementer is told to leave the tree clean when it escalates', async () => {
  const { prompt } = await run(start)
  assert.match(prompt('implement-1'), /leave the working tree clean/)
})

const FOOTER = /\n---\nWritten by agents with \[dev-work\]\(https:\/\/github\.com\/sebmartin\/dev-work\)\.$/

test('the PR description always ends with the dev-work footer, added by the script', async () => {
  const { result, prompt } = await run(start)
  assert.match(result.pr_body, FOOTER)
  assert.match(prompt('write-up'), /one is added for you/)
})

test('a review round that rewrites the description gets the footer too, and one that does not returns none', async () => {
  const rewrites = { 'round-1-write-up': () => ({ replies: [{ id: 'PR1-1', reply: 'Fixed in abc1234: renamed.' }], pr_body: 'NEW-BODY' }) }
  assert.match((await run(round, rewrites)).result.pr_body, FOOTER)
  assert.equal((await run(round)).result.pr_body, '')
})

test('a review round that keeps the footer it was given still ends with exactly one', async () => {
  const keeps = { 'round-1-write-up': () => ({ replies: [{ id: 'PR1-1', reply: 'Fixed in abc1234: renamed.' }], pr_body: 'NEW-BODY\n\n---\nWritten by agents with [dev-work](https://github.com/sebmartin/dev-work).\n' }) }
  const body = (await run(round, keeps)).result.pr_body
  assert.match(body, FOOTER)
  assert.equal(body.split('Written by agents with').length, 2)
  assert.match(body, /^NEW-BODY\n\n---\n/)
  // A description edited on GitHub comes back with CRLF; a reworded link or a missing period is still a footer.
  const crlf = { 'round-1-write-up': () => ({ replies: [], pr_body: 'NEW-BODY\r\n\r\n---\r\nWritten by agents with [dev-work](https://example.org/x)\r\n' }) }
  const b2 = (await run(round, crlf)).result.pr_body
  assert.equal(b2.split('Written by agents with').length, 2)
  assert.match(b2, /^NEW-BODY\n\n---\n/)
})

test('the final write-up keeps exactly one footer when it writes one itself', async () => {
  const keeps = { 'write-up': () => ({ title: 'T', body: 'BODY\n\n---\nWritten by agents with [dev-work](https://github.com/sebmartin/dev-work).' }) }
  const body = (await run(start, keeps)).result.pr_body
  assert.equal(body.split('Written by agents with').length, 2)
  assert.match(body, FOOTER)
})

test('the round write-up is told the footer is added for it', async () => {
  const { prompt } = await run(round)
  assert.match(prompt('round-1-write-up'), /without the footer at its end/)
})

test('round replies are asked to start with what happened', async () => {
  const { prompt } = await run(round)
  assert.match(prompt('round-1-write-up'), /Fixed in <short commit id>/)
  assert.match(prompt('round-1-write-up'), /Not changed:/)
})

const keptPlan = tasks => () => ({ overview: 'OVERVIEW', global_constraints: 'GC', review_focus: 'RF', assumptions: [], follow_ups: [], tasks })

test('a task marked kept that the earlier run did not finish is built', async () => {
  const { result, calls, prompt } = await run(replanArgs, { plan: keptPlan([
    { n: 1, title: 'one', text: 'TASK ONE', disposition: 'kept', reason: 'still right', from: 1 },
    { n: 2, title: 'two', text: 'TASK TWO', disposition: 'kept', reason: 'looks fine', from: 2 }]) })
  const labels = calls.map(c => c.label)
  assert.ok(!labels.includes('implement-1'))
  assert.ok(labels.includes('implement-2'))
  assert.deepEqual(result.replan_counts, { kept: 1, revised: 0, new: 1, dropped: 0 })
  assert.match(prompt('final-review'), /does not record task 2 as done/)
  const inProgress = { ...replanArgs, replan: { ...replanArgs.replan, tasks: [{ task: 1, title: 'one', state: 'in progress' }] } }
  const r2 = await run(inProgress, { plan: keptPlan([{ n: 1, title: 'one', text: 'T', disposition: 'kept', reason: 'r', from: 1 }]) })
  assert.ok(r2.calls.some(c => c.label === 'implement-1'))
  assert.match(r2.prompt('implement-1'), /change what is on the branch/)
  assert.match(r2.prompt('review-1'), /being revised/)
})

test('a kept task is matched to the earlier run by from, not by its new number', async () => {
  // The earlier run finished task 1 only. The re-planner renumbers: new task 1 says it comes from old task 2, which never ran.
  const renumbered = await run(replanArgs, { plan: keptPlan([
    { n: 1, title: 'two', text: 'TASK TWO', disposition: 'kept', reason: 'r', from: 2 },
    { n: 2, title: 'one', text: 'TASK ONE', disposition: 'kept', reason: 'r', from: 1 }]) })
  const labels = renumbered.calls.map(c => c.label)
  assert.ok(labels.includes('implement-1'))
  assert.ok(!labels.includes('implement-2'))
  // A kept task with no from at all is built, and its reason says why.
  const noFrom = await run(replanArgs, { plan: keptPlan([{ n: 1, title: 'one', text: 'TASK ONE', disposition: 'kept', reason: 'r' }]) })
  assert.ok(noFrom.calls.some(c => c.label === 'implement-1'))
  assert.match(noFrom.prompt('final-review'), /names no earlier task in from/)
  // Two kept tasks can't both claim the same finished task: the second is built.
  const dup = await run(replanArgs, { plan: keptPlan([
    { n: 1, title: 'one', text: 'TASK ONE', disposition: 'kept', reason: 'r', from: 1 },
    { n: 2, title: 'one again', text: 'TASK ONE AGAIN', disposition: 'kept', reason: 'r', from: 1 }]) })
  assert.ok(!dup.calls.some(c => c.label === 'implement-1'))
  assert.ok(dup.calls.some(c => c.label === 'implement-2'))
})

test('a task kept by an earlier re-plan can be kept again through from', async () => {
  const second = { ...replanArgs, replan: { ...replanArgs.replan, tasks: [{ task: 2, title: 'two', state: 'kept', reason: 'still right' }] } }
  const { calls } = await run(second, { plan: keptPlan([{ n: 1, title: 'two', text: 'TASK TWO', disposition: 'kept', reason: 'r', from: 2 }]) })
  assert.ok(!calls.some(c => c.label === 'implement-1'))
})

test('the re-plan schema requires from on no task', async () => {
  const { calls } = await run(replanArgs, { plan: replanned })
  const items = calls.find(c => c.label === 'plan').opts.schema.properties.tasks.items
  assert.ok(!items.required.includes('from'))
  assert.ok(items.properties.from)
})

test('a re-plan from the saved plan alone still accepts kept from the planner', async () => {
  const { calls } = await run({ ...start, replan: { source: 'saved-plan', plan: 'OLD-PLAN', tasks: [], rulings: [], deferred: [], parked: [], decision: '', head: sha('d') } }, { plan: replanned })
  assert.ok(!calls.some(c => c.label === 'implement-1'))
})

test('findings the earlier run surfaced for a human carry into the re-plan', async () => {
  const { result } = await run({ ...replanArgs, replan: { ...replanArgs.replan, surfaced: ['F-2: needs a human'] } }, { plan: replanned })
  assert.match(result.surfaced.join('\n'), /before the re-plan: F-2: needs a human/)
})

test('a failure during the final fix keeps the findings it was fixing', async () => {
  const finalFindings = { 'final-review': () => ({ summary: 's', declined: [], ready: 'No', findings: [{ id: 'F-1', severity: 'Important', text: 'broken thing' }] }) }
  for (const fail of [{ 'final-fix': () => { throw new Error('usage limit reached') } }, { 'final-fix': () => null }, { 'final-re-review': () => null }]) {
    const { result } = await run(start, { ...finalFindings, ...fail })
    assert.equal(result.status, 'failed')
    assert.match(result.parked.join('\n'), /final F-1: broken thing.*open when the run failed/)
  }
})

test("a failure during a review round's fix loop keeps the feedback it was fixing", async () => {
  for (const fail of [{ 'round-1-fix-r1': () => { throw new Error('usage limit reached') } }, { 'round-1-fix-r1': () => null }, { 'round-1-re-review-r1': () => null }]) {
    const { result } = await run(round, fail)
    assert.equal(result.status, 'failed')
    assert.match(result.parked.join('\n'), /round 1 PR1-1: rename x.*open when the run failed/)
  }
})
