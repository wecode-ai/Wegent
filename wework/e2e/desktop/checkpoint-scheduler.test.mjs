import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RESOURCE_EXCLUSIVE_CHECKPOINTS,
  linuxCoreCheckpointResources,
  runWithCheckpointResources,
} from './checkpoint-scheduler.mjs'

test('serializes checkpoints that share an exclusive resource', async () => {
  const active = new Set()
  const overlaps = []
  const completed = []

  await runWithCheckpointResources({
    checkpoints: ['collaboration-a', 'independent', 'collaboration-b'],
    workerCount: 2,
    resourceFor: checkpoint =>
      checkpoint.startsWith('collaboration-') ? 'collaboration-runtime' : null,
    run: async checkpoint => {
      const resource = checkpoint.startsWith('collaboration-')
        ? 'collaboration-runtime'
        : checkpoint
      if (active.has(resource)) overlaps.push(resource)
      active.add(resource)
      await new Promise(resolve => setTimeout(resolve, 10))
      active.delete(resource)
      completed.push(checkpoint)
    },
  })

  assert.deepEqual(overlaps, [])
  assert.deepEqual(
    new Set(completed),
    new Set(['collaboration-a', 'independent', 'collaboration-b'])
  )
})

test('starts resource-constrained checkpoint chains before independent work', async () => {
  const started = []
  const release = new Map()

  const runPromise = runWithCheckpointResources({
    checkpoints: ['independent-a', 'collaboration-a', 'independent-b', 'collaboration-b'],
    workerCount: 2,
    resourceFor: checkpoint =>
      checkpoint.startsWith('collaboration-') ? 'collaboration-runtime' : null,
    run: checkpoint =>
      new Promise(resolve => {
        started.push(checkpoint)
        release.set(checkpoint, resolve)
      }),
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['collaboration-a', 'independent-a'])

  release.get('collaboration-a')()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['collaboration-a', 'independent-a', 'collaboration-b'])

  release.get('independent-a')()
  release.get('collaboration-b')()
  await new Promise(resolve => setImmediate(resolve))
  release.get('independent-b')()
  await runPromise
})

test('serializes checkpoints that overlap on any declared resource', async () => {
  const active = new Set()
  const overlaps = []

  await runWithCheckpointResources({
    checkpoints: ['collaboration', 'resilience', 'other-collaboration'],
    workerCount: 3,
    resourceFor: checkpoint => {
      if (checkpoint === 'collaboration') {
        return ['collaboration-runtime', 'desktop-runtime-intensive']
      }
      if (checkpoint === 'resilience') return ['desktop-runtime-intensive']
      return ['collaboration-runtime']
    },
    run: async checkpoint => {
      const resources =
        checkpoint === 'collaboration'
          ? ['collaboration-runtime', 'desktop-runtime-intensive']
          : checkpoint === 'resilience'
            ? ['desktop-runtime-intensive']
            : ['collaboration-runtime']
      for (const resource of resources) {
        if (active.has(resource)) overlaps.push(resource)
        active.add(resource)
      }
      await new Promise(resolve => setTimeout(resolve, 10))
      for (const resource of resources) active.delete(resource)
    },
  })

  assert.deepEqual(overlaps, [])
})

test('runs resource-exclusive checkpoints alone before parallel work', async () => {
  const started = []
  let exclusiveActive = false
  const startedDuringExclusive = []

  await runWithCheckpointResources({
    checkpoints: ['independent-a', 'release-package-startup', 'independent-b'],
    workerCount: 2,
    resourceFor: () => null,
    exclusiveFor: checkpoint => checkpoint === 'release-package-startup',
    run: async checkpoint => {
      if (checkpoint === 'release-package-startup') {
        exclusiveActive = true
      } else if (exclusiveActive) {
        startedDuringExclusive.push(checkpoint)
      }
      started.push(checkpoint)
      await new Promise(resolve => setTimeout(resolve, 10))
      if (checkpoint === 'release-package-startup') exclusiveActive = false
    },
  })

  assert.equal(started[0], 'release-package-startup')
  assert.deepEqual(startedDuringExclusive, [])
})

test('keeps the real system-idle uninstall checkpoint isolated in the shared policy', async () => {
  const checkpoint = 'plugin-uninstall-lost-response'
  const started = []
  const active = new Set()
  const overlaps = []

  await runWithCheckpointResources({
    checkpoints: ['independent-a', checkpoint, 'independent-b'],
    workerCount: 4,
    resourceFor: () => null,
    exclusiveFor: id => RESOURCE_EXCLUSIVE_CHECKPOINTS.has(id),
    run: async id => {
      started.push(id)
      active.add(id)
      if (active.has(checkpoint) && active.size > 1) overlaps.push([...active])
      await new Promise(resolve => setImmediate(resolve))
      active.delete(id)
    },
  })

  assert.equal(started[0], checkpoint)
  assert.deepEqual(overlaps, [])
})

test('separates Linux Core Python bootstrap from the competing cloud fixtures', async () => {
  const checkpoint = 'python-runtime'
  const cloudCheckpoints = ['collaboration-shared-core', 'collaboration-templates']
  const independent = 'stand-in-memory-timer'
  const active = new Set()
  let independentRanWithPython = false
  let cloudFixturesRanTogether = false

  await runWithCheckpointResources({
    checkpoints: [checkpoint, independent, ...cloudCheckpoints],
    workerCount: 4,
    resourceFor: linuxCoreCheckpointResources,
    run: async id => {
      active.add(id)
      if (active.has(checkpoint)) {
        assert.ok(cloudCheckpoints.every(cloud => !active.has(cloud)))
        independentRanWithPython ||= active.has(independent)
      }
      cloudFixturesRanTogether ||= cloudCheckpoints.every(cloud => active.has(cloud))
      await new Promise(resolve => setImmediate(resolve))
      active.delete(id)
    },
  })

  assert.equal(independentRanWithPython, true)
  assert.equal(cloudFixturesRanTogether, true)
})
