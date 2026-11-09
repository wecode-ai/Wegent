// @vitest-environment node

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { waitForMcpAppText } from '../e2e/desktop/scenarios/mcp-app-session-regression.mjs'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('the first app operation can finish cold connection recovery after process health succeeds', async () => {
  let status = 'Result 0 ui-only-marker'
  const recoveryDeadline = Date.now() + 30000
  await vi.advanceTimersByTimeAsync(1000)
  const frameAction = vi.fn(async () => status)
  const pending = waitForMcpAppText(frameAction, 'Counter 1', recoveryDeadline)
  let settled = false
  void pending.then(() => {
    settled = true
  })

  await vi.advanceTimersByTimeAsync(10500)
  expect(settled).toBe(false)
  status = 'Counter 1'
  await vi.advanceTimersByTimeAsync(100)
  await pending
  expect(settled).toBe(true)
  expect(Date.now()).toBeLessThan(recoveryDeadline)
  expect(frameAction).toHaveBeenCalledWith('text', '#status')
})

test('an initial result never satisfies app recovery within the existing restart budget', async () => {
  const recoveryDeadline = Date.now() + 30000
  await vi.advanceTimersByTimeAsync(23000)
  const pending = waitForMcpAppText(
    async () => 'Result 0 ui-only-marker',
    'Counter 1',
    recoveryDeadline
  )
  const rejected = expect(pending).rejects.toThrow('Counter 1')
  await vi.advanceTimersByTimeAsync(7000)
  await rejected
  expect(Date.now()).toBe(recoveryDeadline)
})

test('ordinary app interactions retain their existing UI deadline and exact counter assertion', async () => {
  const pending = waitForMcpAppText(async () => 'Counter 2', 'Counter 1', Date.now() + 10000)
  const rejected = expect(pending).rejects.toThrow('Counter 1')
  await vi.advanceTimersByTimeAsync(10000)
  await rejected
})
