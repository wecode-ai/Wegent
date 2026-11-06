// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

vi.mock('../e2e/desktop/modules/shared.mjs', () => ({ selectE2EModel: vi.fn() }))
vi.mock('../e2e/desktop/modules/workspace-flows.mjs', () => ({
  reloadMainWindow: vi.fn(),
  waitForWorkbenchDebugState: async () => ({
    workbench: { currentRuntimeTask: { taskId: 'archived-task' } },
  }),
}))
vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: vi.fn(async () => ({ code: 'task_archived' })),
}))

import { verifyArchivedTaskInteractionCleanup } from '../e2e/desktop/modules/human-interaction-archived-task.mjs'
import { reloadMainWindow } from '../e2e/desktop/modules/workspace-flows.mjs'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'

const TIMEOUT_MS = 1234

function fixture({ loading, refreshError }) {
  let refreshed = false
  let refreshRequested = false
  let releaseLoading
  const ready = loading
    ? new Promise(resolve => {
        releaseLoading = () => {
          loading = false
          resolve()
        }
      })
    : Promise.resolve()
  const waits = []
  return {
    releaseLoading,
    refreshed: () => refreshed,
    refreshRequested: () => refreshRequested,
    waits,
    control: {
      async command(action, selector, options) {
        if (selector.includes('interactions-refresh')) {
          refreshRequested = true
          if (action === 'clickWhenEnabled') {
            if (refreshError) throw refreshError
            await ready
          }
          assert.equal(loading, false, 'The refresh button is disabled while loading')
          assert.equal(options, undefined, 'Use the existing shared action budget')
          refreshed = true
        }
        if (action === 'waitFor' && /interactions-(empty|pending-count)/.test(selector)) {
          assert.ok(refreshed, 'The real refresh must precede cleanup assertions')
          assert.equal(options.timeoutMs, TIMEOUT_MS)
          waits.push({ selector, options })
        }
        if (action === 'getElementCount') return '0'
      },
    },
  }
}

test.each([false, true])('refreshes archived work after loading=%s finishes', async loading => {
  vi.clearAllMocks()
  const state = fixture({ loading })
  const result = verifyArchivedTaskInteractionCleanup(state.control, TIMEOUT_MS)
  await vi.waitFor(() => assert.ok(state.refreshRequested()))
  if (loading) {
    assert.equal(state.refreshed(), false)
    assert.equal(reloadMainWindow.mock.calls.length, 0)
    state.releaseLoading()
  }
  await result
  assert.equal(state.refreshed(), true)
  assert.equal(state.waits.length, 3)
  assert.equal(state.waits[1].options.text, '0')
  assert.equal(state.waits[1].options.stableMs, 6_000)
  assert.equal(reloadMainWindow.mock.calls.length, 1)
  assert.deepEqual(requestExecutor.mock.calls, [
    [state.control, 'runtime.tasks.get', { taskId: 'archived-task' }, TIMEOUT_MS],
  ])
})

test('propagates refresh readiness failure without asserting cleanup or reloading', async () => {
  vi.clearAllMocks()
  const error = new Error('Refresh remained disabled within the shared action budget')
  const state = fixture({ loading: true, refreshError: error })
  await assert.rejects(
    verifyArchivedTaskInteractionCleanup(state.control, TIMEOUT_MS),
    cause => cause === error
  )
  assert.equal(state.refreshed(), false)
  assert.deepEqual(state.waits, [])
  assert.equal(reloadMainWindow.mock.calls.length, 0)
  assert.equal(requestExecutor.mock.calls.length, 0)
})
