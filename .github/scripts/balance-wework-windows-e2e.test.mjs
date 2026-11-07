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
// verifies that unknown checkpoints keep their runner without pinning measured work.
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

test('an unmeasured checkpoint stays put without pinning unrelated measured work', () => {
  const matrix = {
    include: [
      {
        id: 'core-3',
        segments:
          'dots-closed-loops,application-menu,cloud-context-resilience,background-terminals',
      },
      { id: 'core-1', segments: 'send-key-preference' },
    ],
  }
  const balanced = balanceWindowsMatrix(matrix, {
    'application-menu': 40,
    'cloud-context-resilience': 46,
    'background-terminals': 83,
    'send-key-preference': 17,
  })
  const retained = balanced.include.find(shard => shard.id === 'core-3').segments.split(',')
  assert.ok(retained.includes('dots-closed-loops'))
  assert.ok(!retained.includes('background-terminals'))
  assert.deepEqual(segments(balanced).sort(), segments(matrix).sort())
  assert.equal(balanced.include.length, matrix.include.length)
})

test('retains measured work when evacuation would increase the known peak', () => {
  const matrix = {
    include: [
      { id: 'core-3', segments: 'dots-closed-loops,application-menu' },
      { id: 'core-1', segments: 'background-terminals' },
    ],
  }
  assert.deepEqual(
    balanceWindowsMatrix(matrix, { 'application-menu': 40, 'background-terminals': 83 }),
    matrix
  )
})

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
    const originalSegments = productionShard.segments.split(',')
    const retained = balancedProductionShard.segments.split(',')
    assert.ok(
      originalSegments
        .filter(segment => checkpointSeconds(segment) === null)
        .every(segment => retained.includes(segment))
    )
    assert.ok(retained.every(segment => originalSegments.includes(segment)))
  } else {
    assert.notDeepEqual(
      balancedProductionShard,
      productionShard,
      'The measured production shard must no longer be frozen by stand-in-git'
    )
  }
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
  const ordinary = matrix =>
    matrix.include.filter(shard => !['core-9', 'core-10'].includes(shard.id))
  assert.ok(
    Math.max(...ordinary(balanced).map(measuredLoad)) <=
      Math.max(...ordinary(completeMatrix).map(measuredLoad))
  )
  for (const shard of completeMatrix.include) {
    for (const segment of shard.segments.split(',')) {
      if (checkpointSeconds(segment) !== null) continue
      const result = balanced
      const retained = result.include.find(entry => entry.id === shard.id).segments.split(',')
      assert.ok(retained.includes(segment))
      assert.ok(retained.every(value => shard.segments.split(',').includes(value)))
    }
    const partial = { include: [shard] }
    const result = balanceWindowsMatrix(partial)
    assert.equal(result.include.length, 1)
    assert.deepEqual(segments(result).sort(), segments(partial).sort())
  }
  assert.deepEqual(balanceWindowsMatrix({ include: [] }), { include: [] })
  assert.deepEqual(balanceWindowsMatrix(original, {}), original)
})

test('unknown preparation members keep their shared preparation group on its original runner', () => {
  const matrix = {
    include: [
      { id: 'core-1', segments: 'local-harness,claude-runtime' },
      { id: 'core-2', segments: 'background-terminals' },
    ],
  }
  const balanced = balanceWindowsMatrix(matrix, {
    'claude-runtime': 160,
    'background-terminals': 80,
  })
  assert.deepEqual(balanced, matrix)
})

test('additional unmeasured checkpoints cannot raise known peaks or receive new siblings', () => {
  const measured = JSON.parse(
    readFileSync(new URL('../ci/wework-windows-checkpoint-durations.json', import.meta.url))
  ).seconds
  for (const missing of [
    ['window-lifecycle'],
    ['model-settings', 'browser-toolbar-actions'],
    ['stand-in', 'application-menu', 'streaming-content'],
  ]) {
    const seconds = { ...measured }
    for (const segment of missing) delete seconds[segment]
    const balanced = balanceWindowsMatrix(completeMatrix, seconds)
    const load = shard =>
      shard.segments
        .split(',')
        .reduce((total, segment) => total + (checkpointSeconds(segment, seconds) ?? 0), 0)
    const ordinary = matrix =>
      matrix.include.filter(shard => !['core-9', 'core-10'].includes(shard.id))
    assert.ok(
      Math.max(...ordinary(balanced).map(load)) <= Math.max(...ordinary(completeMatrix).map(load))
    )
    assert.deepEqual(segments(balanced).sort(), segments(completeMatrix).sort())
    assert.equal(balanced.include.length, completeMatrix.include.length)
    for (const shard of completeMatrix.include) {
      const originalSegments = shard.segments.split(',')
      if (originalSegments.every(segment => checkpointSeconds(segment, seconds) !== null)) continue
      const retained = balanced.include.find(entry => entry.id === shard.id).segments.split(',')
      assert.ok(retained.every(segment => originalSegments.includes(segment)))
      for (const segment of originalSegments.filter(
        segment => checkpointSeconds(segment, seconds) === null
      )) {
        assert.ok(retained.includes(segment))
      }
    }
  }
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
