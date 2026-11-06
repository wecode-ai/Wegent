// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { verifyArchivedTaskInteractionCleanup } from '../e2e/desktop/modules/human-interaction-archived-task.mjs'
import { DEFAULT_MODEL_LABEL, MODEL_PROVIDER_ID } from '../e2e/desktop/modules/shared.mjs'

test('archived interaction cleanup waits for inbox refresh readiness and verifies persistent removal', async () => {
  let archived = false
  let refreshReady = true
  let refreshReadiness
  let refreshCount = 0
  let reloaded = false
  let archiveRead = false
  const emptyChecks = []
  const control = {
    readyCount: 1,
    async awaitReadyAfter(count) {
      assert.equal(count, 1)
      assert.equal(reloaded, true)
    },
    async command(action, selector, options = {}) {
      if (action === 'getText') return DEFAULT_MODEL_LABEL
      if (action === 'getAttribute') return MODEL_PROVIDER_ID
      if (action === 'getWorkbenchDebugSnapshot')
        return JSON.stringify({ workbench: { currentRuntimeTask: { taskId: 'archive-target' } } })
      if (action === 'click' && selector.includes('runtime-local-task-archive-archive-target'))
        archived = true
      if (
        action === 'click' &&
        archived &&
        selector.includes('workspace-tab-select-pending-interactions')
      ) {
        refreshReady = false
        refreshReadiness = new Promise(resolve => {
          setImmediate(() => {
            refreshReady = true
            resolve()
          })
        })
      }
      if (selector.includes('interactions-refresh')) {
        if (action === 'clickWhenEnabled') await refreshReadiness
        assert.equal(refreshReady, true, 'Inbox refresh is still disabled after tab activation')
        refreshCount += 1
      }
      if (action === 'waitFor' && selector.includes('interactions-empty')) {
        assert.equal(refreshCount, 1)
        emptyChecks.push(reloaded)
      }
      if (action === 'waitFor' && selector.includes('interactions-pending-count'))
        assert.equal(options.stableMs, 6_000)
      if (action === 'getElementCount') return '0'
      if (action === 'reloadMainWindow') reloaded = true
      if (action === 'getLocationOrigin') return 'http://localhost'
      if (action === 'fetchLocalRuntime') {
        const request = JSON.parse(JSON.parse(options.value).body)
        assert.equal(request.method, 'runtime.tasks.get')
        assert.deepEqual(request.params, { taskId: 'archive-target' })
        archiveRead = true
        return JSON.stringify({
          status: 200,
          body: JSON.stringify({ ok: true, result: { code: 'task_archived' } }),
        })
      }
      return ''
    },
  }

  await verifyArchivedTaskInteractionCleanup(control, 1_000)

  assert.equal(archived, true)
  assert.deepEqual(emptyChecks, [false, true])
  assert.equal(archiveRead, true)
})
