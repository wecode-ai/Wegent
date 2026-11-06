import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { expandDesktopCheckpoints } from '../../wework/e2e/desktop/checkpoints.mjs'
import { balanceLinuxCoreMatrix, orderLinuxCheckpoints } from './order-wework-linux-e2e.mjs'
import { isResourceExclusiveCheckpoint } from '../../wework/e2e/desktop/checkpoint-scheduler.mjs'
import { balanceUnitTests } from './balance-wework-unit-tests.mjs'
import { coreRunnerSlots } from './core-runner-slots.mjs'

const root = new URL('../../', import.meta.url)
function fullMatrix() {
  const directory = mkdtempSync(join(tmpdir(), 'ci-runner-capacity-'))
  try {
    const output = join(directory, 'output')
    execFileSync('bash', ['.github/scripts/classify-wework-desktop-e2e.sh', '--all'], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output },
    })
    const line = readFileSync(output, 'utf8').split('\n')
      .find(value => value.startsWith('wework_desktop_core_e2e_matrix='))
    return JSON.parse(line.slice(line.indexOf('=') + 1))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const original = fullMatrix()
const checkpoints = matrix => matrix.include.flatMap(entry =>
  expandDesktopCheckpoints(entry.segments.split(','))).sort()

test('capacity scales selected runners and stays bounded by available work', () => {
  assert.equal(coreRunnerSlots(original.include, 160, 1.5).length, 5)
  assert.equal(coreRunnerSlots(original.include.slice(0, 2), 20, 1.5).length, 1)
  assert.deepEqual(coreRunnerSlots(original.include, 10, 1.5), [])
  assert.deepEqual(coreRunnerSlots([], 0, 1.5), [])
  assert.deepEqual(coreRunnerSlots(original.include, 160), [])
  for (const scale of [0, -1, NaN, Infinity])
    assert.throws(() => coreRunnerSlots(original.include, 160, scale), /Invalid/)
})

test('benchmark checkpoints cannot create empty ordinary runners in narrow selections', () => {
  const matrix = { include: [
    { id: 'core-6', segments: 'running-conversation-history' },
    ...original.include.filter(entry => ['core-9', 'core-10'].includes(entry.id)),
  ] }
  const result = balanceLinuxCoreMatrix(matrix, undefined, 1.5)
  assert.equal(result.include.length, matrix.include.length)
  assert.deepEqual(checkpoints(result), checkpoints(matrix))
})

test('workflow enables the tested capacity and keeps sharding tests in CI', () => {
  const readWorkflow = path => JSON.parse(execFileSync('ruby', [
    '-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0]))', path,
  ], { cwd: root, encoding: 'utf8' }))
  const desktop = readWorkflow('.github/workflows/wework-e2e.yml')
  const step = desktop.jobs.changes.steps.find(entry => entry.id === 'linux-matrix')
  assert.equal(Number(step.env.CORE_RUNNER_SCALE), 1.5)
  const units = readWorkflow('.github/workflows/test.yml').jobs['test-wework']
  assert.deepEqual(units.strategy.matrix.shard, [1, 2, 3, 4])
  assert(units.steps.find(entry => entry.name === 'Run Wework tests')
    .run.includes('--shard=${{ matrix.shard }}/4'))
  const lint = readFileSync(new URL('../workflows/lint.yml', import.meta.url), 'utf8')
  assert(lint.includes('.github/scripts/core-runner-slots.test.mjs'))
})

for (const [platform, balance, script, args] of [
  ['Linux', balanceLinuxCoreMatrix, 'order-wework-linux-e2e.mjs', ['--balance-core']],
]) {
  test(`${platform} uses 15 nonempty runners with exact coverage and exclusive benchmarks`, () => {
    const snapshot = JSON.stringify(original)
    const result = balance(original, undefined, 1.5)
    assert.equal(result.include.length, 15)
    assert.equal(new Set(result.include.map(entry => entry.id)).size, 15)
    assert.deepEqual(checkpoints(result), checkpoints(original))
    assert.equal(new Set(checkpoints(result)).size, checkpoints(original).length)
    for (const id of ['core-9', 'core-10'])
      assert.deepEqual(result.include.find(entry => entry.id === id),
        original.include.find(entry => entry.id === id))
    assert.equal(JSON.stringify(original), snapshot)
    assert.deepEqual(balance(original, undefined, 1.5), result)
    const cli = execFileSync(process.execPath, [`.github/scripts/${script}`, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CORE_MATRIX: snapshot, CORE_RUNNER_SCALE: '1.5' },
    }).trim()
    assert.deepEqual(JSON.parse(cli.slice('matrix='.length)), result)
  })
}

test('additional Linux runners reduce the measured four-worker critical path', () => {
  const { scopes: { core: seconds }, workers } = JSON.parse(readFileSync(
    new URL('../ci/wework-linux-checkpoint-durations.json', import.meta.url), 'utf8'))
  const longest = matrix => Math.max(...matrix.include.map(entry => {
    const selected = orderLinuxCheckpoints(entry.segments.split(','), 'core')
    const exclusive = selected.filter(checkpoint => isResourceExclusiveCheckpoint(checkpoint, true))
    const loads = Array(workers).fill(exclusive.reduce(
      (sum, checkpoint) => sum + (seconds[checkpoint] ?? 180), 0))
    for (const checkpoint of selected.filter(value => !exclusive.includes(value))) {
      const worker = loads.indexOf(Math.min(...loads))
      loads[worker] += seconds[checkpoint] ?? 180
    }
    return Math.max(...loads)
  }))
  const before = longest(balanceLinuxCoreMatrix(original))
  const after = longest(balanceLinuxCoreMatrix(original, undefined, 1.5))
  assert(after < before, `${before}s -> ${after}s`)
  console.log(`Measured Linux checkpoint critical path: ${before}s -> ${after}s`)
})

test('four unit shards preserve every measured file once and halve predicted renderer work', () => {
  const evidence = JSON.parse(readFileSync(
    new URL('../ci/wework-unit-test-durations.json', import.meta.url), 'utf8'))
  const files = Object.keys(evidence.milliseconds)
  const split = count => Array.from({ length: count }, (_, index) =>
    balanceUnitTests(files, index + 1, count))
  const longest = shards => Math.max(...shards.map(shard => shard.reduce(
    (sum, file) => sum + evidence.milliseconds[file] + evidence.perFileOverheadMs, 0)))
  assert.deepEqual(split(4).flat().sort(), [...files].sort())
  assert(longest(split(4)) < longest(split(2)) * 0.55)
})
