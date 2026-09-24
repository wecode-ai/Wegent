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
