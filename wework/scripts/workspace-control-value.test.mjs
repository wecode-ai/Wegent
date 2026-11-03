import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { waitForControlValue } from '../e2e/desktop/modules/workspace-flows.mjs'

afterEach(() => vi.useRealTimers())

test('checks the value after mounting consumes the previous step budget', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const actions = []
  await waitForControlValue(
    {
      async command(action) {
        actions.push(action)
        if (action === 'waitFor') vi.setSystemTime(10_001)
        return '/remote/home'
      },
    },
    'input',
    '/remote/home',
    'Missing remote home'
  )
  assert.deepEqual(actions, ['waitFor', 'getValue'])
})

test('still rejects a different path after the value deadline', async () => {
  vi.useFakeTimers()
  const checking = waitForControlValue(
    {
      async command() {
        return '/wrong/home'
      },
    },
    'input',
    '/remote/home',
    'Missing remote home'
  ).then(
    () => null,
    error => error
  )
  await vi.advanceTimersByTimeAsync(10_000)
  const error = await checking
  assert.match(error.message, /expected="\/remote\/home", received="\/wrong\/home"/)
})

test('preserves the prerequisite failure without reading an unmounted input', async () => {
  const error = new Error('Input did not mount')
  const command = vi.fn().mockRejectedValue(error)
  await assert.rejects(waitForControlValue({ command }, 'input', '/home', 'Missing home'), error)
  assert.equal(command.mock.calls.length, 1)
  assert.equal(command.mock.calls[0][0], 'waitFor')
})
