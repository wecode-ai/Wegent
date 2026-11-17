// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { waitForDomChange } from './waitForDomChange'

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

test('observes text ready before the deadline without waiting for a delayed poll', async () => {
  vi.useFakeTimers()
  const element = document.createElement('div')
  document.body.append(element)
  const started = Date.now()
  const deadline = started + 10
  let observedAt: number | undefined
  const waiting = waitForDomChange(document).then(() => {
    if (element.textContent === 'completed') observedAt = Date.now()
  })
  vi.setSystemTime(started + 9)
  element.textContent = 'completed'
  await waiting
  expect(observedAt).toBeLessThan(deadline)
  expect(vi.getTimerCount()).toBe(0)
})

test('retains polling when only layout or external state changes', async () => {
  vi.useFakeTimers()
  const observer = vi.spyOn(MutationObserver.prototype, 'disconnect')
  let completed = false
  const waiting = waitForDomChange(document).then(() => {
    completed = true
  })
  await vi.advanceTimersByTimeAsync(15)
  expect(completed).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await waiting
  expect(completed).toBe(true)
  expect(observer).toHaveBeenCalledOnce()
  vi.restoreAllMocks()
})
