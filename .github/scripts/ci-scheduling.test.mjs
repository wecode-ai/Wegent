import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

function workflow(name) {
  return JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
    'puts JSON.generate(YAML.load_file(ARGV[0]))', `.github/workflows/${name}.yml`], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
  }))
}

function workflowOutput(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-scheduling-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return name => join(directory, name)
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

test('renderer performance runs for affected inputs and explicit full regressions', t => {
  const classify = desktop.jobs.changes.steps.find(step => step.id === 'classify').run
  const outputPath = workflowOutput(t)
  for (const [path, forceAll, expected] of [
    ['.github/workflows/wework-e2e.yml', false, false],
    ['wework/src/components/chat/ChatMessage.tsx', false, true],
    ['wework/scripts/profile-renderer.mjs', false, true],
    ['.github/workflows/wework-e2e.yml', true, true],
  ]) {
    const output = outputPath(path.replaceAll('/', '-') + '-' + forceAll)
    execFileSync('bash', ['-e', '-c',
      'git() { printf "%s\\n" "$CHANGED_PATH"; }\n' + classify,
    ], {
      cwd: new URL('../../', import.meta.url),
      encoding: 'utf8',
      env: {
        ...process.env,
        BASE_SHA: 'base',
        HEAD_SHA: 'head',
        CHANGED_PATH: path,
        FORCE_ALL: String(forceAll),
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_OUTPUT: output,
      },
    })
    assert.equal(readFileSync(output, 'utf8').split('\n').includes('renderer_profile=true'), expected, path)
  }
})

test('obsolete main warmups cancel and branch dispatches cannot populate shared caches', () => {
  assert.equal(warmup.concurrency['cancel-in-progress'], true)
  assert.equal(evaluate(warmup.jobs.changes.if, { ref: 'refs/heads/main' }), true)
  assert.equal(evaluate(warmup.jobs.changes.if, { ref: 'refs/heads/topic', event_name: 'workflow_dispatch' }), false)
})

test('replacement warmup includes inputs since the last successful push', t => {
  const classify = warmup.jobs.changes.steps.find(step => step.id === 'classify').run
  const lastSuccessful = 'a'.repeat(40)
  const output = workflowOutput(t)('warmup')
  execFileSync('bash', ['-e', '-o', 'pipefail', '-c', `
    gh() { printf '%s\\n' "$LAST_SUCCESSFUL"; }
    git() {
      case "$1" in
        cat-file|merge-base) return 0 ;;
        diff)
          [[ "$3" == "$LAST_SUCCESSFUL...$GITHUB_SHA" ]] || return 1
          printf '%s\\n' 'backend-rs/execution-completion/src/persist.rs'
          ;;
      esac
    }
    ${classify}
  `], {
    cwd: new URL('../../', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      BEFORE_SHA: 'b'.repeat(40),
      LAST_SUCCESSFUL: lastSuccessful,
      GITHUB_SHA: 'c'.repeat(40),
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REPOSITORY: 'example/project',
      GITHUB_OUTPUT: output,
    },
  })
  assert.ok(readFileSync(output, 'utf8').split('\n').includes('backend_rs_rust=true'))
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
