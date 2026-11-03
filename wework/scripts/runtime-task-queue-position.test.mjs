import assert from 'node:assert/strict'
import { test } from 'vitest'

import { assertQueuePosition } from '../e2e/desktop/scenarios/runtime-task-queue.scenario.mjs'

test.each([true, false])(
  'retains the matched queue position when the row is replaced after the bridge response (visible=%s)',
  async visible => {
    let rowText = '2'
    const control = {
      async command(action, _selector, options) {
        if (action === 'waitFor') {
          assert.equal(options.visible, visible || undefined)
          const matchedText = rowText
          rowText = ''
          return matchedText
        }
        return rowText
      },
    }

    await assertQueuePosition(control, '[data-testid="queue-position"]', '2', visible)
    assert.equal(rowText, '', 'The fixture must replace the row before a second read')
  }
)

test.each(['', '1', '12'])('rejects an invalid queue position %j', async text => {
  const control = {
    async command() {
      return text
    },
  }
  await assert.rejects(
    assertQueuePosition(control, '[data-testid="queue-position"]', '2', true),
    /No queue position found|Expected a queue position of 2/
  )
})

test('preserves bridge failures without issuing another command', async () => {
  const failure = new Error('The queue position did not become visible')
  let commands = 0
  const control = {
    async command() {
      commands += 1
      throw failure
    },
  }

  await assert.rejects(
    assertQueuePosition(control, '[data-testid="queue-position"]', '2', true),
    error => error === failure
  )
  assert.equal(commands, 1)
})
