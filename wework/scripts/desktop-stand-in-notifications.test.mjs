import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { openStandInNotificationInbox } from '../e2e/desktop/scenarios/stand-in-notifications.scenario.mjs'

const BUTTON = '[data-testid="wework-notifications-button"]'
const CATEGORY = '[data-testid="wework-notifications-category-collaboration"]'

test('waits for the notification button and category to mount after renderer registration', async () => {
  const calls = []
  const mounted = new Set()
  const releases = new Map()
  const readiness = new Map(
    [BUTTON, CATEGORY].map(selector => [
      selector,
      new Promise(resolve => {
        releases.set(selector, () => {
          mounted.add(selector)
          resolve()
        })
      }),
    ])
  )
  const control = {
    async command(action, selector) {
      calls.push({ action, selector })
      if (action === 'clickWhenEnabled') await readiness.get(selector)
      assert.ok(
        mounted.has(selector),
        'Renderer registration does not imply mounted shell controls'
      )
    },
  }
  const opening = openStandInNotificationInbox(control).then(
    () => null,
    error => error
  )

  await Promise.resolve()
  assert.deepEqual(calls, [{ action: 'clickWhenEnabled', selector: BUTTON }])
  releases.get(BUTTON)()
  await vi.waitFor(() => assert.equal(calls.length, 2))
  assert.deepEqual(calls[1], { action: 'clickWhenEnabled', selector: CATEGORY })
  releases.get(CATEGORY)()
  assert.equal(await opening, null)
})

test.each([BUTTON, CATEGORY])('propagates an unavailable inbox control: %s', async missing => {
  const calls = []
  const failure = new Error('Notification control did not become available')
  const control = {
    async command(action, selector) {
      calls.push({ action, selector })
      if (selector === missing) throw failure
    },
  }

  await assert.rejects(openStandInNotificationInbox(control), error => error === failure)
  assert.deepEqual(
    calls,
    (missing === BUTTON ? [BUTTON] : [BUTTON, CATEGORY]).map(selector => ({
      action: 'clickWhenEnabled',
      selector,
    }))
  )
})
