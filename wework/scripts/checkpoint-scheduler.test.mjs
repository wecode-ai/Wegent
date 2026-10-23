import assert from 'node:assert/strict'
import { test } from 'vitest'

import { runWithCheckpointResources } from '../e2e/desktop/checkpoint-scheduler.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('terminal native input runs alone before ordinary checkpoints regain parallelism', async () => {
  const started = []
  const release = new Map()
  const checkpoints = ['ordinary-a', 'background-terminals', 'ordinary-b', 'ordinary-c']
  const pending = runWithCheckpointResources({
    checkpoints,
    workerCount: 3,
    resourceFor: () => [],
    run: checkpoint =>
      new Promise(resolve => {
        started.push(checkpoint)
        release.set(checkpoint, resolve)
      }),
  })

  await tick()
  assert.deepEqual(started, ['background-terminals'])
  release.get('background-terminals')()
  await tick()
  assert.deepEqual(started, ['background-terminals', 'ordinary-a', 'ordinary-b', 'ordinary-c'])
  for (const resolve of release.values()) resolve()
  await pending
  assert.equal(new Set(started).size, checkpoints.length)
})

test('multiple exclusive checkpoints never overlap with each other or shared resources', async () => {
  const active = new Set()
  const completed = []
  const exclusiveFor = checkpoint => checkpoint.startsWith('exclusive')
  await runWithCheckpointResources({
    checkpoints: ['ordinary-a', 'exclusive-a', 'ordinary-b', 'exclusive-b'],
    workerCount: 4,
    resourceFor: () => ['shared-resource'],
    exclusiveFor,
    run: async checkpoint => {
      assert.equal(active.size, 0)
      active.add(checkpoint)
      await tick()
      active.delete(checkpoint)
      completed.push(checkpoint)
    },
  })
  assert.deepEqual(completed, ['exclusive-a', 'exclusive-b', 'ordinary-a', 'ordinary-b'])
})

test('exclusive checkpoint failures propagate without retaining the runner lease', async () => {
  const completed = []
  const failure = new Error('Native keyboard verification failed')
  await assert.rejects(
    runWithCheckpointResources({
      checkpoints: ['background-terminals', 'ordinary'],
      workerCount: 2,
      resourceFor: () => [],
      run: async checkpoint => {
        if (checkpoint === 'background-terminals') throw failure
        completed.push(checkpoint)
      },
    }),
    error => error === failure
  )
  await tick()
  assert.deepEqual(completed, ['ordinary'])
})
