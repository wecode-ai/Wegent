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

function processDeadlineSeconds() {
  const wrapper = readFileSync(
    new URL('./run-windows-standard-user-process.ps1', import.meta.url),
    'utf8'
  )
  const deadline =
    Number(
      wrapper.match(/\$remainingSeconds = (\d+) \* 60 - \$deadlineClock.Elapsed.TotalSeconds/)?.[1]
    ) * 60
  assert.ok(Number.isFinite(deadline) && deadline > 0)
  return deadline
}

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
    balanceWindowsMatrix(matrix, {
      'application-menu': 40,
      'background-terminals': 83,
    }),
    matrix
  )
})

test('rebalances displaced work without adding foreign work to an unmeasured runner', () => {
  const matrix = {
    include: [
      { id: 'core-1', segments: 'application-menu' },
      { id: 'core-2', segments: 'background-terminals' },
      {
        id: 'core-3',
        segments:
          'coordination-history,send-key-preference,cloud-context-resilience,browser-toolbar-actions,project-ai-settings',
      },
    ],
  }
  const seconds = {
    'application-menu': 10,
    'background-terminals': 10,
    'send-key-preference': 15,
    'cloud-context-resilience': 5,
    'browser-toolbar-actions': 5,
    'project-ai-settings': 5,
  }
  const balanced = balanceWindowsMatrix(matrix, seconds)
  const load = shard =>
    shard.segments
      .split(',')
      .reduce((total, segment) => total + (checkpointSeconds(segment, seconds) ?? 0), 0)
  assert.equal(Math.max(...balanced.include.map(load)), 20)
  assert.deepEqual(segments(balanced).sort(), segments(matrix).sort())
  const retained = balanced.include.find(shard => shard.id === 'core-3').segments.split(',')
  assert.ok(retained.includes('coordination-history'))
  assert.ok(retained.every(segment => matrix.include[2].segments.split(',').includes(segment)))
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
    'dots-closed-loops',
    'idle-executor-requests',
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
  assert.equal(balanced.include.length, completeMatrix.include.length + 1)
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
    assert.equal(balanced.include.length, completeMatrix.include.length + 1)
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

test('extra capacity is limited to a complete workload that one runner can make fit', () => {
  const cheap = Object.fromEntries(checkpoints(completeMatrix).map(checkpoint => [checkpoint, 1]))
  assert.equal(
    balanceWindowsMatrix(completeMatrix, cheap).include.length,
    completeMatrix.include.length
  )
  const oversized = {
    ...cheap,
    'application-menu': processDeadlineSeconds() + 1,
  }
  assert.equal(
    balanceWindowsMatrix(completeMatrix, oversized).include.length,
    completeMatrix.include.length
  )
  const balanced = balanceWindowsMatrix(completeMatrix)
  assert.equal(balanced.include.length, completeMatrix.include.length + 1)
  assert.ok(balanced.include.some(shard => shard.id === 'core-11'))
  for (const id of ['core-9', 'core-10']) {
    assert.deepEqual(
      balanced.include.find(shard => shard.id === id),
      completeMatrix.include.find(shard => shard.id === id)
    )
  }
})

test('scheduler capacity uses the actual existing process deadline', () => {
  const evidence = JSON.parse(
    readFileSync(new URL('../ci/wework-windows-checkpoint-durations.json', import.meta.url))
  )
  assert.equal(evidence.processDeadlineSeconds, processDeadlineSeconds())
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
  const jobs = JSON.parse(
    execFileSync(
      'ruby',
      [
        '-ryaml',
        '-rjson',
        '-e',
        "puts JSON.generate(YAML.load_file(ARGV[0])['jobs'])",
        '.github/workflows/wework-e2e.yml',
      ],
      { cwd: root, encoding: 'utf8' }
    )
  )
  const worker = jobs['wework-desktop-windows-core-e2e']
  const steps = worker.steps
  const producerSteps = jobs['build-wework-desktop-windows-core-e2e'].steps
  const balanced = balanceWindowsMatrix(original)
  const completeBalanced = balanceWindowsMatrix(completeMatrix)
  const evidence = JSON.parse(
    readFileSync(new URL('../ci/wework-windows-checkpoint-durations.json', import.meta.url))
  )
  const preparationWeights = {
    'Install local harness CLIs': evidence.preparationSeconds['local-harness'],
    'Prepare DingTalk protocol fixture for the standard account':
      evidence.preparationSeconds['dingtalk-protocol-fixture'],
  }
  const objectStorage = producerSteps.find(step => step.name === 'Build real object storage')
  assert.equal(objectStorage?.if, "steps.issue-mcp-minio.outputs.cache-hit != 'true'")
  const restoreObjectStorage = producerSteps.find(
    step => step.name === 'Restore real object storage for desktop E2E'
  )
  assert.ok(restoreObjectStorage)
  assert.equal(restoreObjectStorage.if, undefined)
  assert.equal(
    steps.some(step => step.name === 'Build real object storage'),
    false
  )
  assert.equal(producerSteps.filter(step => step.name === 'Build real object storage').length, 1)
  assert.ok(worker.needs.includes('build-wework-desktop-windows-core-e2e'))
  const storageDownload = steps.find(step => step.name === 'Download Windows real object storage')
  const storageUpload = producerSteps.find(
    step => step.name === 'Upload Windows real object storage'
  )
  assert.ok(storageDownload)
  assert.ok(storageUpload)
  assert.equal(storageDownload.if, undefined)
  assert.equal(storageUpload.if, undefined)
  assert.equal(storageDownload.with.name, storageUpload.with.name)
  assert.equal(storageDownload.with.path, '${{ runner.temp }}/wework-minio/bin')
  assert.equal(storageUpload.with.path, '${{ runner.temp }}/wework-minio/bin/minio.exe')
  assert.equal(storageUpload.with['if-no-files-found'], 'error')
  const preparationLoads = matrix => matrix.include.map(measuredLoad)
  const totalCost = loads =>
    evidence.preparationSeconds['object-storage'] + loads.reduce((a, b) => a + b)
  const originalLoads = preparationLoads(original)
  const balancedLoads = preparationLoads(balanced)
  const completeOriginalLoads = preparationLoads(completeMatrix)
  const completeBalancedLoads = preparationLoads(completeBalanced)
  for (const name of [
    'Install local harness CLIs',
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
  assert.equal(totalCost(balancedLoads), totalCost(originalLoads))
  assert.ok(Math.max(...balancedLoads) < Math.max(...originalLoads))
  assert.equal(totalCost(completeBalancedLoads), totalCost(completeOriginalLoads))
  assert.ok(Math.max(...completeBalancedLoads) <= Math.max(...completeOriginalLoads))
  const testStep = steps.find(step => step.name === 'Run Windows Wework desktop Core shard E2E')
  assert.ok(testStep?.['timeout-minutes'] > 0)
  const budget = processDeadlineSeconds()
  assert.ok(budget < testStep['timeout-minutes'] * 60)
  assert.ok(Math.max(...completeBalancedLoads) + evidence.runnerOverheadSeconds < budget)
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
  assert.ok(Number.isFinite(evidence.runnerOverheadSeconds) && evidence.runnerOverheadSeconds > 0)
  assert.match(evidence.runnerOverheadSource, /\/actions\/runs\/\d+\/job\/\d+$/)
  const current = evidence.currentPrMeasurements
  assert.ok(evidence.runs.includes(current.run))
  assert.match(current.head, /^[a-f0-9]{40}$/)
  assert.ok(Object.keys(current.sources).length > 0)
  for (const [checkpoint, source] of Object.entries(current.sources)) {
    assert.ok(Object.hasOwn(evidence.seconds, checkpoint), checkpoint)
    assert.ok(source.startsWith(`${current.run}/job/`), source)
    assert.match(source, /\/job\/\d+$/)
  }
})

function replayedShardSeconds(shard, seconds, overheadSeconds) {
  return shard.segments.split(',').reduce((total, segment) => {
    const duration = checkpointSeconds(segment, seconds)
    assert.notEqual(duration, null, `${shard.id}: missing duration for ${segment}`)
    return total + duration
  }, overheadSeconds)
}

test('deadline replay rejects unknown durations and preserves known sums', () => {
  const shard = { id: 'fixture', segments: 'send-key-preference' }
  assert.throws(() => replayedShardSeconds(shard, {}, 125), /missing duration/)
  assert.equal(replayedShardSeconds(shard, { 'send-key-preference': 17 }, 125), 142)
})

function assertDeadlineReplay(replay) {
  const workflow = readFileSync(new URL('../workflows/wework-e2e.yml', import.meta.url), 'utf8')
  const stepBudget =
    Number(
      workflow.match(
        /name: Run Windows Wework desktop Core shard E2E[\s\S]*?timeout-minutes: (\d+)/
      )?.[1]
    ) * 60
  const budget = processDeadlineSeconds()
  assert.ok(budget > 0 && budget < stepBudget)
  const observed = { ...replay.unobservedSeconds, ...replay.seconds }
  assert.deepEqual(
    replay.matrix.include.map(shard => shard.id),
    Array.from({ length: 10 }, (_, index) => `core-${index + 1}`)
  )
  assert.equal(Object.keys(observed).length, replay.checkpointCount)
  assert.ok(Object.keys(replay.unobservedSeconds).every(key => !Object.hasOwn(replay.seconds, key)))
  for (const seconds of Object.values(observed)) assert.ok(Number.isFinite(seconds) && seconds > 0)
  const covered = []
  for (const shard of balanceWindowsMatrix(replay.matrix).include) {
    if (['core-9', 'core-10'].includes(shard.id)) continue
    covered.push(...expandDesktopCheckpoints(shard.segments.split(',')))
    const seconds = replayedShardSeconds(shard, observed, replay.runnerOverheadSeconds)
    assert.ok(seconds < budget, `${shard.id}: historical replay ${seconds}s exceeds ${budget}s`)
  }
  assert.deepEqual(covered.sort(), Object.keys(observed).sort())
  const unobserved = checkpoints(completeMatrix).filter(key => !Object.hasOwn(observed, key))
  if (unobserved.length)
    console.log(`[windows-deadline-replay] no historical prediction for: ${unobserved.join(',')}`)
}

test('historical Windows workloads fit the step deadline with complete replay coverage', () => {
  assertDeadlineReplay(
    JSON.parse(
      readFileSync(new URL('./fixtures/wework-windows-deadline-replay.json', import.meta.url))
    )
  )
})

test('new Windows checkpoint measurements leave room for startup and cleanup', () => {
  assertDeadlineReplay(
    JSON.parse(
      readFileSync(
        new URL('./fixtures/wework-windows-cleanup-deadline-replay.json', import.meta.url)
      )
    )
  )
})

test('complete real-Backend Windows workloads retain cleanup time within the deadline', () => {
  assertDeadlineReplay(
    JSON.parse(
      readFileSync(
        new URL('./fixtures/wework-windows-real-backend-deadline-replay.json', import.meta.url)
      )
    )
  )
})

test('current Windows workloads fit the process deadline before the step deadline', () => {
  assertDeadlineReplay(
    JSON.parse(
      readFileSync(
        new URL('./fixtures/wework-windows-current-deadline-replay.json', import.meta.url)
      )
    )
  )
})
