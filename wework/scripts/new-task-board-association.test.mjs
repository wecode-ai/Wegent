// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

const { requestExecutor } = vi.hoisted(() => ({ requestExecutor: vi.fn() }))
vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor }))

import { waitForBinding } from '../e2e/desktop/modules/new-task-board-association.mjs'

test('draft binding retries while the Runtime has not persisted the new task', async () => {
  const control = {
    command: vi.fn(async () =>
      JSON.stringify({
        workbench: { currentRuntimeTask: { deviceId: 'device-1', taskId: 'runtime-1' } },
      })
    ),
  }
  requestExecutor
    .mockRejectedValueOnce(new Error('runtime_tasks.context returned HTTP 500: task not found'))
    .mockResolvedValueOnce({ cloud_project_id: 7, loop_item_id: 'item-1' })

  const binding = await waitForBinding(control, 7, 'item-1')

  assert.deepEqual(binding, { cloud_project_id: 7, loop_item_id: 'item-1' })
  assert.equal(requestExecutor.mock.calls.length, 2)
})
