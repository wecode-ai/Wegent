import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { blurE2EWindow, focusE2EWindow } from './e2e-window-focus.js'

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
test('observes acquired native focus at the deadline when no later event arrives', async () => {
  vi.useFakeTimers()
  const target = Object.assign(new EventEmitter(), { isFocused: vi.fn(() => false) })
  const activate = vi.fn()
  const finished = vi.fn()
  const pending = focusE2EWindow(target, activate).then(finished)
  target.emit('focus')
  await vi.advanceTimersByTimeAsync(4999)
  expect(finished).not.toHaveBeenCalled()
  target.isFocused.mockReturnValue(true)
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(finished).toHaveBeenCalledOnce()
  expect(activate).toHaveBeenCalledOnce()
  expect(target.listenerCount('focus')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
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

test('waits for actual native blur after the deactivation call returns', async () => {
  const target = Object.assign(new EventEmitter(), { isFocused: vi.fn(() => true) })
  const deactivate = vi.fn()
  const finished = vi.fn()
  const pending = blurE2EWindow(target, deactivate).then(finished)
  await Promise.resolve()
  expect(deactivate).toHaveBeenCalledOnce()
  expect(finished).not.toHaveBeenCalled()
  target.isFocused.mockReturnValue(false)
  target.emit('blur')
  await pending
  expect(finished).toHaveBeenCalledOnce()
  expect(target.listenerCount('blur')).toBe(0)
})
