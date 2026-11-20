// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  selectE2EModel: async () => {},
}))

import { createPersistentInteractionNoticeCase } from '../e2e/desktop/modules/human-interaction-persistent-notice.mjs'

const notice = '[data-testid="runtime-interaction-notice"]'
const absent = `body:not(:has(${notice}))`

function fixture(removeNotice) {
  const scenario = createPersistentInteractionNoticeCase()
  let pendingCountCleared = false
  let noticePresent = true
  let waitedForRemoval = false
  const response = { end() {} }
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'click' && selector.includes('send-message-button')) {
        scenario.handleModel(
          {
            input: [{ role: 'user', content: 'HUMAN_INTERACTIONS_REVIEW_PERSISTENT_NOTICE' }],
            tools: [{ type: 'function', name: 'request_user_input_async' }],
          },
          response
        )
      }
      if (action === 'waitFor' && selector.includes('interactions-pending-count')) {
        assert.equal(options.text, '0')
        pendingCountCleared = true
        if (removeNotice) setTimeout(() => (noticePresent = false), 10)
      }
      if (action === 'waitFor' && selector === absent) {
        assert.equal(pendingCountCleared, true)
        waitedForRemoval = true
        const deadline = Date.now() + 100
        while (noticePresent && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 2))
        if (noticePresent) throw new Error('Timed out waiting for reminder removal')
      }
      if (action === 'getElementCount' && selector === notice) return noticePresent ? '1' : '0'
      return ''
    },
  }
  return {
    run: () => scenario.verify(control, 100),
    observedRemoval: () => waitedForRemoval && !noticePresent,
  }
}

test('waits for reminder removal after the pending count has already reached zero', async () => {
  const flow = fixture(true)
  await flow.run()
  assert.equal(flow.observedRemoval(), true)
})

test('still fails when a resolved reminder remains mounted', async () => {
  const flow = fixture(false)
  await assert.rejects(flow.run(), /reminder/)
})
