// @vitest-environment node

import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { waitForScenarioProgress } from '../../e2e/desktop/modules/scenario-progress.mjs'

afterEach(() => vi.useRealTimers())

test('each completed capability gets the existing response budget without an aggregate UI deadline', async () => {
  vi.useFakeTimers()
  const events = new EventEmitter()
  let step = 0
  const completed = vi.fn()
  const wait = waitForScenarioProgress(events, () => ({ step }), 3, 100).then(completed)
  for (let next = 1; next <= 3; next += 1) {
    await vi.advanceTimersByTimeAsync(90)
    expect(completed).not.toHaveBeenCalled()
    step = next
    events.emit('change')
  }
  await wait
  expect(completed).toHaveBeenCalledOnce()
  expect(events.listenerCount('change')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

test('a stalled capability fails at its response deadline and removes listeners', async () => {
  vi.useFakeTimers()
  const events = new EventEmitter()
  const wait = waitForScenarioProgress(events, () => ({ step: 2 }), 3, 100)
  const rejected = expect(wait).rejects.toThrow('Scenario stopped at step 2/3 for 100ms')
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  expect(events.listenerCount('change')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

test('a real assertion failure aborts immediately and preserves its original error', async () => {
  vi.useFakeTimers()
  const events = new EventEmitter()
  const state: { step: number; error?: Error } = { step: 0 }
  const wait = waitForScenarioProgress(events, () => state, 3, 100)
  const failure = new Error('Original permission assertion failed')
  const rejected = expect(wait).rejects.toBe(failure)
  state.error = failure
  events.emit('change')
  await rejected
  expect(events.listenerCount('change')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
