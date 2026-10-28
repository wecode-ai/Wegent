import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { expandDesktopCheckpoints } from '../../wework/e2e/desktop/checkpoints.mjs'
import { balanceWindowsMatrix, checkpointSeconds } from './balance-wework-windows-e2e.mjs'

const root = new URL('../../', import.meta.url)
function classifiedCoreMatrix() {
  const directory = mkdtempSync(join(tmpdir(), 'wework-core-matrix-'))
  const output = join(directory, 'github-output')
  try {
    execFileSync('bash', ['.github/scripts/classify-wework-desktop-e2e.sh', '--all'], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output },
    })
    const matrixLine = readFileSync(output, 'utf8')
      .split('\n')
      .find(line => line.startsWith('wework_desktop_core_e2e_matrix='))
    assert.ok(matrixLine, 'The classifier must emit its complete Core matrix')
    return JSON.parse(matrixLine.slice(matrixLine.indexOf('=') + 1))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const original = classifiedCoreMatrix()
const segments = matrix => matrix.include.flatMap(shard => shard.segments.split(','))
const checkpoints = matrix =>
  matrix.include.flatMap(shard => expandDesktopCheckpoints(shard.segments.split(',')))
const measuredLoad = shard =>
  shard.segments.split(',').reduce((total, segment) => total + (checkpointSeconds(segment) ?? 0), 0)

test('measured Windows scheduling preserves every segment and expanded checkpoint exactly once', () => {
  const balanced = balanceWindowsMatrix(original)
  assert.deepEqual(segments(balanced).sort(), segments(original).sort())
  assert.deepEqual(checkpoints(balanced).sort(), checkpoints(original).sort())
  assert.equal(new Set(checkpoints(balanced)).size, checkpoints(original).length)
  assert.equal(balanced.include.length, original.include.length)
  assert.deepEqual(balanceWindowsMatrix(original), balanced)
  for (const id of ['core-9', 'core-10']) {
    assert.deepEqual(
      balanced.include.find(shard => shard.id === id),
      original.include.find(shard => shard.id === id)
    )
  }
  const ordinary = matrix =>
    matrix.include.filter(shard => !['core-9', 'core-10'].includes(shard.id))
  assert.ok(
    Math.max(...ordinary(balanced).map(measuredLoad)) <
      Math.max(...ordinary(original).map(measuredLoad))
  )
})

test('unmeasured checkpoints retain their original shard and partial selection never adds runners', () => {
  for (const shard of original.include) {
    for (const segment of shard.segments.split(',')) {
      if (checkpointSeconds(segment) !== null) continue
      const result = balanceWindowsMatrix(original)
      assert.deepEqual(
        result.include.find(entry => entry.id === shard.id),
        shard
      )
    }
    const partial = { include: [shard] }
    const result = balanceWindowsMatrix(partial)
    assert.equal(result.include.length, 1)
    assert.deepEqual(segments(result).sort(), segments(partial).sort())
  }
  assert.deepEqual(balanceWindowsMatrix({ include: [] }), { include: [] })
  assert.deepEqual(balanceWindowsMatrix(original, {}), original)
})

test('duplicate selection is rejected rather than silently losing coverage', () => {
  assert.throws(
    () =>
      balanceWindowsMatrix({
        include: [original.include[0], original.include[0]],
      }),
    /Duplicate/
  )
})

test('timing evidence contains positive successful samples with source run links', () => {
  const evidence = JSON.parse(
    readFileSync(new URL('../ci/wework-windows-checkpoint-durations.json', import.meta.url))
  )
  assert.ok(evidence.runs.length > 0)
  for (const run of evidence.runs)
    assert.match(run, /^https:\/\/github.com\/wecode-ai\/Wegent\/actions\/runs\/\d+$/)
  for (const seconds of Object.values(evidence.seconds))
    assert.ok(Number.isFinite(seconds) && seconds > 0)
})
