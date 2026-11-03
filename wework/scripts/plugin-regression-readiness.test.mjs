import { afterEach, expect, test, vi } from 'vitest'
import { until } from '../e2e/desktop/modules/plugin-regression-fixture.mjs'

afterEach(() => vi.useRealTimers())

test('resource admission observations leave the renderer idle between one-second polls', async () => {
  vi.useFakeTimers()
  let ready = false
  const read = vi.fn(() => ready)
  const result = until(read, Boolean, 'resource admission', 10_000, 1000)
  await vi.advanceTimersByTimeAsync(999)
  const observationsBeforeReady = read.mock.calls.length
  ready = true
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toBe(true)
  expect(observationsBeforeReady).toBe(1)
})

test('ordinary UI observations retain their 100-millisecond interval', async () => {
  vi.useFakeTimers()
  let ready = false
  const read = vi.fn(() => ready)
  const result = until(read, Boolean, 'UI readiness')
  await vi.advanceTimersByTimeAsync(99)
  expect(read).toHaveBeenCalledOnce()
  ready = true
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toBe(true)
})

test('resource admission still fails when its real condition never becomes true', async () => {
  vi.useFakeTimers()
  const result = until(() => false, Boolean, 'guard was not observed', 2000, 1000)
  const failure = expect(result).rejects.toThrow('guard was not observed')
  await vi.advanceTimersByTimeAsync(2000)
  await failure
})
