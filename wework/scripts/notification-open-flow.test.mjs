import assert from 'node:assert/strict'
import test from 'node:test'

import { openCollaborationNotifications } from '../e2e/desktop/modules/stand-in-flows.mjs'

test('waits for the reloaded notification shell and then its category before clicking', async () => {
  const button = '[data-testid="wework-notifications-button"]'
  const category = '[data-testid="wework-notifications-category-collaboration"]'
  const pending = new Map()
  const clicked = []
  const calls = []
  const control = {
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      assert.equal(action, 'clickWhenEnabled', 'Reconnection alone must not trigger a raw click')
      await new Promise(resolve => pending.set(selector, resolve))
      clicked.push(selector)
    },
  }

  const opening = openCollaborationNotifications(control)
  assert.deepEqual(clicked, [])
  assert.deepEqual([...pending.keys()], [button])
  pending.get(button)()
  // Wait for the first command and the continuation that opens its category.
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(clicked, [button])
  assert.ok(pending.has(category))
  pending.get(category)()
  await opening
  assert.deepEqual(clicked, [button, category])
  assert.ok(
    calls.every(call => call.options === undefined),
    'Keep the shared step budget'
  )
})

test('propagates a missing notification shell instead of skipping the notification assertions', async () => {
  const unavailable = new Error('Notification shell did not mount')
  let calls = 0
  await assert.rejects(
    openCollaborationNotifications({
      async command() {
        calls += 1
        throw unavailable
      },
    }),
    error => error === unavailable
  )
  assert.equal(calls, 1)
})
