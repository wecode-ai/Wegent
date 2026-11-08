// @vitest-environment node

import { expect, test, vi } from 'vitest'
import { restoreDisabledReplyPredictions } from '../e2e/desktop/scenarios/reply-predictions-background.scenario.mjs'

test.each(['true', 'false'])(
  'cleanup restores a %s preference without enabling it',
  async checked => {
    const control = {
      command: vi.fn(async action => (action === 'getAttribute' ? checked : undefined)),
    }
    await restoreDisabledReplyPredictions(control)
    const clicks = control.command.mock.calls.filter(([action]) => action === 'click')
    expect(clicks).toHaveLength(checked === 'true' ? 1 : 0)
    expect(control.command).toHaveBeenLastCalledWith(
      'waitFor',
      '[data-testid="reply-prediction-enabled"][aria-checked="false"]'
    )
  }
)

test('cleanup retains the original failure alongside its own error', async () => {
  const verificationError = new Error('Original verification failure')
  const cleanupError = new Error('Cleanup navigation failed')
  const control = { command: vi.fn().mockRejectedValue(cleanupError) }
  await expect(restoreDisabledReplyPredictions(control, verificationError)).rejects.toMatchObject({
    errors: [verificationError, cleanupError],
  })
})

test('cleanup failures still fail an otherwise successful scenario', async () => {
  const cleanupError = new Error('Cleanup navigation failed')
  const control = { command: vi.fn().mockRejectedValue(cleanupError) }
  await expect(restoreDisabledReplyPredictions(control)).rejects.toBe(cleanupError)
})
