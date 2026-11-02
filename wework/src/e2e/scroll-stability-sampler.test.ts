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

test('keeps delayed input in the sample until the interaction explicitly stops it', async () => {
  vi.useFakeTimers()
  const scroller = viewport(1000, 900)
  const anchor = document.createElement('div')
  scroller.append(anchor)
  document.body.append(scroller)
  vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(
    () => ({ top: 900 - scroller.scrollTop }) as DOMRect
  )
  const sample = startScrollStabilitySampler(
    () => anchor,
    () => [scroller],
    10_000
  )

  // Real host commands may outlast a short observation window before input finishes.
  for (let index = 0; index < 6; index += 1) {
    await vi.advanceTimersByTimeAsync(350)
    scroller.scrollTop -= 24
    scroller.dispatchEvent(new Event('scroll'))
  }
  await vi.advanceTimersByTimeAsync(1200)
  expect(sample.done).toBe(false)
  expect(sample.scrollEvents).toHaveLength(6)
  expect(sample.frames.at(-1)).toMatchObject({ anchorTop: 144, scrollTop: 756 })
  expect(sample.frames.at(-1)!.time).toBeGreaterThan(1200)

  sample.stop()
  const frameCount = sample.frames.length
  scroller.scrollTop -= 24
  scroller.dispatchEvent(new Event('scroll'))
  await vi.advanceTimersByTimeAsync(1200)
  expect(sample.done).toBe(true)
  expect(sample.frames).toHaveLength(frameCount)
  expect(sample.scrollEvents).toHaveLength(6)
  expect(vi.getTimerCount()).toBe(0)
})
