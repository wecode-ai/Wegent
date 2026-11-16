import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { focusE2EWindow } from './e2e-window-focus.js'

afterEach(() => vi.useRealTimers())
test('waits for actual native focus after the activation call returns', async () => {
  const target = Object.assign(new EventEmitter(), { isFocused: vi.fn(() => false) })
  const activate = vi.fn()
  const finished = vi.fn()
  const pending = focusE2EWindow(target, activate).then(finished)
  await Promise.resolve()
  expect(activate).toHaveBeenCalledOnce()
  expect(finished).not.toHaveBeenCalled()
  target.isFocused.mockReturnValue(true)
  target.emit('focus')
  await pending
  expect(finished).toHaveBeenCalledOnce()
  expect(target.listenerCount('focus')).toBe(0)
})
test('rejects a refused native activation without retrying or reporting success', async () => {
  vi.useFakeTimers()
  const target = Object.assign(new EventEmitter(), { isFocused: () => false })
  const activate = vi.fn()
  const pending = focusE2EWindow(target, activate)
  const rejected = expect(pending).rejects.toThrow('did not acquire focus')
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(activate).toHaveBeenCalledOnce()
  expect(target.listenerCount('focus')).toBe(0)
})
