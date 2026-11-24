import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createTransientFeedback } from './transientFeedback'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('feedback expires from the last explicit action rather than the first one', () => {
  const feedback = createTransientFeedback(1500)
  const changed = vi.fn(),
    stop = feedback.subscribe(changed)
  expect(feedback.getSnapshot()).toBe(false)
  feedback.show()
  vi.advanceTimersByTime(1000)
  feedback.show()
  vi.advanceTimersByTime(1499)
  expect(feedback.getSnapshot()).toBe(true)
  vi.advanceTimersByTime(1)
  expect(feedback.getSnapshot()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  stop()
})

test('last observer cancels feedback and a late completion cannot start a detached timer', () => {
  const feedback = createTransientFeedback(600)
  const stop = feedback.subscribe(vi.fn())
  feedback.show()
  stop()
  feedback.show()
  expect(feedback.getSnapshot()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  const stopAgain = feedback.subscribe(vi.fn())
  expect(feedback.getSnapshot()).toBe(false)
  stopAgain()
})

test('the receipt remains active while another surface observes it', () => {
  const feedback = createTransientFeedback(600)
  const stop = feedback.subscribe(vi.fn()),
    remaining = vi.fn()
  const stopOther = feedback.subscribe(remaining)
  feedback.show()
  stop()
  expect(feedback.getSnapshot()).toBe(true)
  vi.advanceTimersByTime(600)
  expect(feedback.getSnapshot()).toBe(false)
  expect(remaining).toHaveBeenCalledTimes(2)
  stopOther()
})

test('notification that removes the surface also cancels the newly registered timer', () => {
  const feedback = createTransientFeedback(600)
  const stop = feedback.subscribe(() => stop())
  feedback.show()
  expect(feedback.getSnapshot()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  expect(feedback.getServerSnapshot()).toBe(false)
})
