import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

function workflow(name) {
  return JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
    'puts JSON.generate(YAML.load_file(ARGV[0]))', `.github/workflows/${name}.yml`], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
  }))
}

const desktop = workflow('wework-e2e')
const warmup = workflow('ci-cache-warmup')
const context = (action, label = '') => ({
  workflow: 'Wework E2E', event_name: 'pull_request', run_id: 1, ref: 'refs/pull/1/merge',
  event: { action, label: { name: label }, pull_request: { number: 1 } },
})
const evaluate = (expression, github) => runInNewContext(expression, {
  github, always: () => true, cancelled: () => false,
})
const group = github => desktop.concurrency.group.replace(/\$\{\{(.*?)\}\}/g,
  (_, expression) => String(evaluate(expression, github)))

test('ci:all supersedes ordinary work for the same PR; unrelated labels cannot cancel it', () => {
  assert.equal(group(context('synchronize')), group(context('labeled', 'ci:all')))
  assert.notEqual(group(context('synchronize')), group(context('labeled', 'documentation')))
  const another = context('synchronize')
  another.event.pull_request.number = 2
  assert.notEqual(group(context('synchronize')), group(another))
  assert.equal(desktop.concurrency['cancel-in-progress'], true)
})

test('unrelated labels execute neither desktop builds nor a replacement success summary', () => {
  for (const action of ['opened', 'synchronize', 'ready_for_review', 'labeled']) {
    for (const label of ['ci:all', 'documentation']) {
      const expected = action !== 'labeled' || label === 'ci:all'
      for (const job of ['changes', 'wework-e2e-summary']) {
        assert.equal(evaluate(desktop.jobs[job].if, context(action, label)), expected)
      }
    }
  }
})

test('obsolete main warmups cancel and branch dispatches cannot populate shared caches', () => {
  assert.equal(warmup.concurrency['cancel-in-progress'], true)
  assert.equal(evaluate(warmup.jobs.changes.if, { ref: 'refs/heads/main' }), true)
  assert.equal(evaluate(warmup.jobs.changes.if, { ref: 'refs/heads/topic', event_name: 'workflow_dispatch' }), false)
})

test('unit, lint and runtime producers survive unrelated label events', () => {
  for (const [name, summary] of [['test', 'test-summary'], ['lint', 'lint-summary'], ['e2e-tests', 'platform-e2e-summary']]) {
    const source = workflow(name)
    const render = github => source.concurrency.group.replace(/\$\{\{(.*?)\}\}/g,
      (_, expression) => String(evaluate(expression, github)))
    assert.equal(render(context('synchronize')), render(context('labeled', 'ci:all')))
    assert.notEqual(render(context('synchronize')), render(context('labeled', 'documentation')))
    for (const job of ['changes', summary]) {
      assert.equal(evaluate(source.jobs[job].if, context('synchronize')), true)
      assert.equal(evaluate(source.jobs[job].if, context('labeled', 'documentation')), false)
    }
  }
})
