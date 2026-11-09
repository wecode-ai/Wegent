import { expect, test } from 'vitest'
import { assertQueuePosition } from '../e2e/desktop/scenarios/runtime-task-queue.scenario.mjs'

test.each([true, false])(
  'reads queue position in one UI observation (visible=%s)',
  async visible => {
    const observations = []
    const control = {
      async command(action, selector, options) {
        observations.push({ action, selector, options })
        if (action === 'waitFor') return '2'
        // A sidebar refresh replaces the matching node before a second query.
        if (action === 'getText') return ''
        throw new Error(`Unexpected action: ${action}`)
      },
    }

    await assertQueuePosition(control, '[data-testid="queue-position"]', '2', visible)

    expect(observations).toEqual([
      {
        action: 'waitFor',
        selector: '[data-testid="queue-position"]',
        options: { ...(visible ? { visible: true } : {}), text: '2' },
      },
    ])
  }
)

test.each(['', '12', '3'])('rejects missing or incorrect queue position %j', async text => {
  const control = { command: async () => text }
  await expect(assertQueuePosition(control, 'queue-position', '2', true)).rejects.toThrow()
})
