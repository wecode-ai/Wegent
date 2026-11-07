import { afterEach, expect, test, vi } from 'vitest'
import { finishStartupHandoffPhase, startStartupMaintenance } from './startup-tasks.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('maintenance neither waits for a pending operation nor propagates sync or async failures', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const failure = new Error('Read-only directory')
  expect(startStartupMaintenance('pending', () => new Promise(() => {}))).toBeUndefined()
  startStartupMaintenance('tray', () => {
    throw failure
  })
  startStartupMaintenance('logs', () => Promise.reject(failure))
  await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(2))
})

test('a hung animation releases startup and clears its deadline', async () => {
  vi.useFakeTimers()
  const failure = expect(
    finishStartupHandoffPhase('animation', () => new Promise(() => {}))
  ).rejects.toThrow('1500ms')
  await vi.advanceTimersByTimeAsync(1500)
  await failure
  expect(vi.getTimerCount()).toBe(0)
})

test('successful animation does not leave a pending deadline', async () => {
  vi.useFakeTimers()
  await expect(finishStartupHandoffPhase('animation', async () => 'completed')).resolves.toBe(
    'completed'
  )
  expect(vi.getTimerCount()).toBe(0)
})
