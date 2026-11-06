// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { verifyArchivedTaskInteractionCleanup } from '../../e2e/desktop/modules/human-interaction-archived-task.mjs'
import { DEFAULT_MODEL_LABEL, MODEL_PROVIDER_ID } from '../../e2e/desktop/modules/shared.mjs'
import { createBarrier } from '../test/async-barrier'

test('archived interaction cleanup waits for the current refresh before refreshing the inbox', async () => {
  const waiting = createBarrier()
  const refreshed = createBarrier()
  const reachedEmptyCheck = new Error('The manual refresh was accepted')
  let archived = false
  let refreshAccepted = false
  const verification = verifyArchivedTaskInteractionCleanup(
    {
      async command(action: string, selector: string) {
        if (selector.includes('interactions-refresh')) {
          assert.equal(archived, true)
          if (action === 'click') throw new Error('The inbox is still loading')
          assert.equal(action, 'clickWhenEnabled')
          waiting.release()
          await refreshed.promise
          refreshAccepted = true
        }
        if (selector.includes('interactions-empty')) {
          assert.equal(refreshAccepted, true)
          throw reachedEmptyCheck
        }
        if (selector.includes('runtime-local-task-archive-toast-')) archived = true
        if (action === 'getWorkbenchDebugSnapshot')
          return JSON.stringify({ workbench: { currentRuntimeTask: { taskId: 'archived-task' } } })
        if (action === 'getText' && selector.includes('model-selector-button'))
          return DEFAULT_MODEL_LABEL
        if (action === 'getAttribute' && selector.includes('model-selector-button'))
          return MODEL_PROVIDER_ID
        return ''
      },
    },
    1_000
  ).then(
    () => new Error('Expected the inbox assertion boundary'),
    (error: unknown) => error
  )
  try {
    assert.equal(
      await Promise.race([waiting.promise.then(() => 'waiting'), verification]),
      'waiting'
    )
    assert.equal(refreshAccepted, false)
  } finally {
    refreshed.release()
  }
  assert.equal(await verification, reachedEmptyCheck)
})
