import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithCheckpointResources } from './checkpoint-scheduler.mjs'

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
