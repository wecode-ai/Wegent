import assert from 'node:assert/strict'
import test from 'node:test'

import { waitForForkTaskRow } from '../e2e/desktop/modules/runtime-task-evidence.mjs'

test('ignores a late sidebar task while the fork still has the source active', async () => {
  const observed = []
  const activeTasks = ['source', 'fork', 'fork']
  let snapshotCount = 0
  const control = {
    async command(method) {
      observed.push(method)
      if (method === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({
          workbench: { currentRuntimeTask: { taskId: activeTasks.shift() } },
        })
      }
      assert.equal(method, 'snapshot')
      snapshotCount++
      return JSON.stringify({
        testIds: [
          'runtime-local-task-row-source',
          'runtime-local-task-row-late-existing',
          ...(snapshotCount > 1 ? ['runtime-local-task-row-fork'] : []),
        ],
      })
    },
  }

  assert.equal(await waitForForkTaskRow(control, 'source', 1_000), 'runtime-local-task-row-fork')
  assert.deepEqual(observed, [
    'getWorkbenchDebugSnapshot',
    'getWorkbenchDebugSnapshot',
    'snapshot',
    'getWorkbenchDebugSnapshot',
    'snapshot',
  ])
})

test('times out instead of accepting the unchanged source task', async () => {
  const control = {
    async command(method) {
      assert.equal(method, 'getWorkbenchDebugSnapshot')
      return JSON.stringify({ workbench: { currentRuntimeTask: { taskId: 'source' } } })
    },
  }

  await assert.rejects(
    waitForForkTaskRow(control, 'source', 20),
    /fork of source did not open.*active task: source/
  )
})
