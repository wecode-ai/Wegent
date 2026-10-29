import { afterEach, expect, test, vi } from 'vitest'
import { startScrollStabilitySampler } from './scroll-stability-sampler'

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

function viewport(height: number, top: number) {
  const element = document.createElement('div')
  element.dataset.testid = 'scroller'
  Object.defineProperties(element, {
    clientHeight: { value: 100 },
    scrollHeight: { value: height },
  })
  element.scrollTop = top
  return element
}

test('captures the first replacement-pane commit and follows the anchor-owned scroller', async () => {
  vi.useFakeTimers()
  const blank = viewport(100, 0)
  document.body.append(blank)
  const sample = startScrollStabilitySampler(
    () => document.querySelector<HTMLElement>('[data-testid="anchor"]') ?? undefined,
    () => [...document.querySelectorAll<HTMLElement>('[data-testid="scroller"]')],
    1000
  )
  expect(sample.frames).toHaveLength(0)
  const task = viewport(1000, 450)
  const anchor = document.createElement('p')
  anchor.dataset.testid = 'anchor'
  task.append(anchor)
  document.body.append(task)
  await Promise.resolve()
  // No timer tick: the very first pane commit must already use the task's metrics.
  expect(sample.frames[0]).toMatchObject({ scrollHeight: 1000, scrollTop: 450, clientHeight: 100 })
  task.scrollTop = 900
  task.dispatchEvent(new Event('scroll'))
  expect(sample.scrollEvents.at(-1)).toMatchObject({ scrollHeight: 1000, scrollTop: 900 })

  const reopened = viewport(600, 500)
  reopened.append(anchor)
  task.replaceWith(reopened)
  await Promise.resolve()
  expect(sample.frames.at(-1)).toMatchObject({ scrollHeight: 600, scrollTop: 500 })
  const eventCount = sample.scrollEvents.length
  task.dispatchEvent(new Event('scroll'))
  expect(sample.scrollEvents).toHaveLength(eventCount)
  reopened.dispatchEvent(new Event('scroll'))
  expect(sample.scrollEvents.at(-1)).toMatchObject({ scrollHeight: 600, scrollTop: 500 })
  sample.stop()
  const frameCount = sample.frames.length
  anchor.textContent = 'After stop'
  await vi.advanceTimersByTimeAsync(1000)
  expect(sample.done).toBe(true)
  expect(sample.frames).toHaveLength(frameCount)
})
