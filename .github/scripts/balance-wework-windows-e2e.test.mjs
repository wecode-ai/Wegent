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

const completeMatrix = classifiedCoreMatrix()
// Improvement requires measured inputs. The full production matrix below also
// verifies the separate contract that unknown checkpoints freeze their shard.
const original = {
  include: completeMatrix.include
    .map(shard => ({
      ...shard,
      segments: shard.segments
        .split(',')
        .filter(segment => checkpointSeconds(segment) !== null)
        .join(','),
    }))
    .filter(shard => shard.segments),
}
const segments = matrix => matrix.include.flatMap(shard => shard.segments.split(','))
const checkpoints = matrix =>
  matrix.include.flatMap(shard => expandDesktopCheckpoints(shard.segments.split(',')))
const measuredLoad = shard =>
  shard.segments.split(',').reduce((total, segment) => total + (checkpointSeconds(segment) ?? 0), 0)

test('the measured fixture contains every real measured checkpoint exactly once', () => {
  assert.deepEqual(
    segments(original).sort(),
    segments(completeMatrix)
      .filter(segment => checkpointSeconds(segment) !== null)
      .sort()
  )
  assert.equal(new Set(checkpoints(original)).size, checkpoints(original).length)
})

test('previously frozen Windows shards can use their successful checkpoint measurements', () => {
  for (const segment of [
    'follow-up-task-switch',
    'stand-in-alternate-source',
    'stand-in-email',
    'stand-in-git',
    'stand-in-profile',
    'collaboration-milestones',
  ]) {
    assert.notEqual(checkpointSeconds(segment), null, segment)
  }
  const balanced = balanceWindowsMatrix(original)
  assert.notDeepEqual(
    balanced.include.find(shard => shard.id === 'core-3'),
    original.include.find(shard => shard.id === 'core-3')
  )
  const productionShard = completeMatrix.include.find(shard => shard.id === 'core-3')
  const balancedProductionShard = balanceWindowsMatrix(completeMatrix).include.find(
    shard => shard.id === 'core-3'
  )
  if (productionShard.segments.split(',').some(segment => checkpointSeconds(segment) === null)) {
    assert.deepEqual(
      balancedProductionShard,
      productionShard,
      'Other unmeasured checkpoints must still freeze the production shard'
    )
  } else {
    assert.notDeepEqual(
      balancedProductionShard,
      productionShard,
      'The measured production shard must no longer be frozen by stand-in-git'
    )
  }
})

test('the successful Dots sample releases Core3 without losing checkpoints or adding runners', () => {
  const evidence = JSON.parse(
    readFileSync(new URL('../ci/wework-windows-checkpoint-durations.json', import.meta.url))
  )
  assert.equal(checkpointSeconds('dots-closed-loops'), 166)
  assert.equal(
    evidence.checkpointSources['dots-closed-loops'],
    'https://github.com/wecode-ai/Wegent/actions/runs/42376659459/job/128419185892'
  )
  const withoutDots = { ...evidence.seconds }
  delete withoutDots['dots-closed-loops']
  const source = completeMatrix.include.find(shard => shard.id === 'core-3')
  assert.deepEqual(
    balanceWindowsMatrix(completeMatrix, withoutDots).include.find(shard => shard.id === 'core-3'),
    source
  )
  const balanced = balanceWindowsMatrix(completeMatrix)
  assert.notDeepEqual(
    balanced.include.find(shard => shard.id === 'core-3'),
    source
  )
  assert.deepEqual(segments(balanced).sort(), segments(completeMatrix).sort())
  assert.deepEqual(checkpoints(balanced).sort(), checkpoints(completeMatrix).sort())
  assert.equal(new Set(checkpoints(balanced)).size, checkpoints(completeMatrix).length)
  assert.equal(balanced.include.length, completeMatrix.include.length)
  assert.ok(
    measuredLoad(balanced.include.find(shard => shard.id === 'core-3')) < measuredLoad(source)
  )
})

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
  const balanced = balanceWindowsMatrix(completeMatrix)
  assert.deepEqual(segments(balanced).sort(), segments(completeMatrix).sort())
  assert.deepEqual(checkpoints(balanced).sort(), checkpoints(completeMatrix).sort())
  assert.equal(new Set(checkpoints(balanced)).size, checkpoints(completeMatrix).length)
  assert.equal(balanced.include.length, completeMatrix.include.length)
  const movable = matrix =>
    matrix.include.filter(
      shard =>
        !['core-9', 'core-10'].includes(shard.id) &&
        shard.segments.split(',').every(segment => checkpointSeconds(segment) !== null)
    )
  assert.ok(
    Math.max(...movable(balanced).map(measuredLoad)) <=
      Math.max(...movable(completeMatrix).map(measuredLoad))
  )
  for (const shard of completeMatrix.include) {
    for (const segment of shard.segments.split(',')) {
      if (checkpointSeconds(segment) !== null) continue
      const result = balanced
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

test('balancing never multiplies expensive conditional preparation from the original workflow', () => {
  const steps = JSON.parse(
    execFileSync(
      'ruby',
      [
        '-ryaml',
        '-rjson',
        '-e',
        "puts JSON.generate(YAML.load_file(ARGV[0])['jobs']['wework-desktop-windows-core-e2e']['steps'])",
        '.github/workflows/wework-e2e.yml',
      ],
      { cwd: root, encoding: 'utf8' }
    )
  )
  const balanced = balanceWindowsMatrix(original)
  const completeBalanced = balanceWindowsMatrix(completeMatrix)
  const evidence = JSON.parse(
    readFileSync(new URL('../ci/wework-windows-checkpoint-durations.json', import.meta.url))
  )
  const preparationWeights = {
    'Install local harness CLIs': evidence.preparationSeconds['local-harness'],
    'Build real object storage': evidence.preparationSeconds['object-storage'],
    'Prepare DingTalk protocol fixture for the standard account':
      evidence.preparationSeconds['dingtalk-protocol-fixture'],
  }
  const preparationLoads = matrix => matrix.include.map(shard => measuredLoad(shard))
  const originalLoads = preparationLoads(original)
  const balancedLoads = preparationLoads(balanced)
  const completeOriginalLoads = preparationLoads(completeMatrix)
  const completeBalancedLoads = preparationLoads(completeBalanced)
  for (const name of [
    'Install local harness CLIs',
    'Build real object storage',
    'Install Electron for native startup and schema verification',
    'Prepare DingTalk protocol fixture for the standard account',
  ]) {
    const step = steps.find(step => step.name === name)
    assert.ok(step, name)
    const triggers = [...step.if.matchAll(/contains\(matrix.segments, '([^']+)'\)/g)].map(
      match => match[1]
    )
    assert.ok(triggers.length, `Preparation triggers are required for ${name}`)
    for (const [matrix, loads] of [
      [original, originalLoads],
      [balanced, balancedLoads],
      [completeMatrix, completeOriginalLoads],
      [completeBalanced, completeBalancedLoads],
    ]) {
      for (const [index, shard] of matrix.include.entries()) {
        if (triggers.some(segment => shard.segments.split(',').includes(segment))) {
          loads[index] += preparationWeights[name] ?? 0
        }
      }
    }
    const count = matrix =>
      matrix.include.filter(shard => triggers.some(segment => shard.segments.includes(segment)))
        .length
    assert.equal(count(balanced), count(original), name)
    assert.equal(count(completeBalanced), count(completeMatrix), name)
  }
  assert.equal(
    balancedLoads.reduce((a, b) => a + b),
    originalLoads.reduce((a, b) => a + b)
  )
  assert.ok(Math.max(...balancedLoads) < Math.max(...originalLoads))
  assert.equal(
    completeBalancedLoads.reduce((a, b) => a + b),
    completeOriginalLoads.reduce((a, b) => a + b)
  )
  assert.ok(Math.max(...completeBalancedLoads) <= Math.max(...completeOriginalLoads))
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
  for (const seconds of Object.values(evidence.preparationSeconds))
    assert.ok(Number.isFinite(seconds) && seconds > 0)
  assert.match(evidence.preparationSource, /\/actions\/runs\/\d+\/job\/\d+$/)
})
