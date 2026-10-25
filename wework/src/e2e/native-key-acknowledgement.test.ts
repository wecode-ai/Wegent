import { afterEach, expect, test, vi } from 'vitest'
import { sendNativeKeyAndWait } from './native-key-acknowledgement'

afterEach(async () => {
  await vi.runOnlyPendingTimersAsync()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('acknowledges delivered native input without waiting for a renderer timer', async () => {
  vi.useFakeTimers()
  const target = document.createElement('textarea')
  let listener: ((event: KeyboardEvent) => void) | undefined
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => {
    if (type === 'keydown') listener = callback as (event: KeyboardEvent) => void
  })
  const acknowledged = vi.fn()
  const result = sendNativeKeyAndWait(target, 'press', async () => {
    listener?.({ isTrusted: true, target } as unknown as KeyboardEvent)
  }).then(acknowledged)

  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
  expect(acknowledged).toHaveBeenCalledOnce()
  await result
})

test('ignores synthetic events and native events for another target', async () => {
  vi.useFakeTimers()
  const target = document.createElement('textarea')
  let listener: ((event: KeyboardEvent) => void) | undefined
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => {
    if (type === 'keyup') listener = callback as (event: KeyboardEvent) => void
  })
  const acknowledged = vi.fn()
  const result = sendNativeKeyAndWait(target, 'up', async () => {
    listener?.({ isTrusted: false, target } as unknown as KeyboardEvent)
    listener?.({ isTrusted: true, target: document.body } as unknown as KeyboardEvent)
  }).then(acknowledged)
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
  expect(acknowledged).not.toHaveBeenCalled()
  listener?.({ isTrusted: true, target } as unknown as KeyboardEvent)
  await result
  expect(acknowledged).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test('rejects missing native input at the existing step deadline and removes its listener', async () => {
  vi.useFakeTimers()
  const remove = vi.spyOn(window, 'removeEventListener')
  const target = document.createElement('textarea')
  const result = sendNativeKeyAndWait(target, 'down', async () => {})
  const rejected = expect(result).rejects.toThrow('Native keydown did not reach its target')
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true)
  expect(vi.getTimerCount()).toBe(0)
})

test('preserves a host failure even if the event was delivered', async () => {
  vi.useFakeTimers()
  const target = document.createElement('textarea')
  let listener: ((event: KeyboardEvent) => void) | undefined
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => {
    if (type === 'keydown') listener = callback as (event: KeyboardEvent) => void
  })
  const remove = vi.spyOn(window, 'removeEventListener')
  await expect(
    sendNativeKeyAndWait(target, 'press', async () => {
      listener?.({ isTrusted: true, target } as unknown as KeyboardEvent)
      throw new Error('Native host rejected the action')
    })
  ).rejects.toThrow('Native host rejected the action')
  expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true)
  expect(vi.getTimerCount()).toBe(0)
})
