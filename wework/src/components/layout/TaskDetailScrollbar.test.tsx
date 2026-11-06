import { runDesktopControlClient } from '@/e2e/automation'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TaskDetailScrollArea } from './TaskDetailScrollArea'

let contentHeight = 1600
const resizes = new Set<() => void>()
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

function flushFrame() {
  const callbacks = [...frames.values()]
  frames.clear()
  act(() => callbacks.forEach(callback => callback(0)))
}

beforeEach(() => {
  contentHeight = 1600
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: () => void
      constructor(callback: () => void) {
        this.callback = callback
        resizes.add(callback)
      }
      observe() {}
      disconnect() {
        resizes.delete(this.callback)
      }
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
    return this.dataset.testid === 'desktop-workbench-scrollbar' ? 394 : 400
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
    return parseFloat(this.style.height) || 0
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resizes.clear()
})

function renderConversation() {
  const viewportRef = createRef<HTMLDivElement>()
  const scrollbarRef = createRef<HTMLDivElement>()
  const { unmount } = render(
    <TaskDetailScrollArea
      viewportRef={viewportRef}
      scrollbarRef={scrollbarRef}
      defaultEmbeddedBrowserLabel="test"
      hasConversation
      showPageTopBar={false}
    >
      <div>Messages</div>
    </TaskDetailScrollArea>
  )
  const viewport = viewportRef.current!
  const track = scrollbarRef.current!
  track.getBoundingClientRect = () => ({ top: 3 }) as DOMRect
  track.setPointerCapture = vi.fn()
  track.hasPointerCapture = vi.fn().mockReturnValue(true)
  track.releasePointerCapture = vi.fn()
  // Match Chromium's normal scroll range, including range clamping.
  let position = 0
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => position,
    set: value => {
      position = Math.max(0, Math.min(contentHeight - 400, value))
    },
  })
  return {
    viewport,
    track,
    unmount,
    thumb: screen.getByTestId('desktop-workbench-scrollbar-thumb'),
  }
}

test('maps track clicks and continuous dragging to the normal conversation scroll range', () => {
  const { viewport, track, thumb } = renderConversation()
  expect(thumb.style.height).toBe('98.5px')
  expect(thumb.style.transform).toBe('translateY(0px)')

  fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientY: 200 })
  expect(viewport.scrollTop).toBe(600)
  fireEvent.pointerMove(track, { buttons: 1, pointerId: 1, clientY: 3 })
  flushFrame()
  expect(viewport.scrollTop).toBe(0)
  fireEvent.pointerMove(track, { buttons: 1, pointerId: 1, clientY: 397 })
  flushFrame()
  expect(viewport.scrollTop).toBe(1200)
  fireEvent.pointerUp(track, { pointerId: 1 })
  fireEvent.pointerMove(track, { pointerId: 1, clientY: 3 })
  expect(viewport.scrollTop).toBe(1200)
})

test.each(['before grab'])(
  'the continuous drag sampler measures the real grab point: %s',
  async phase => {
    const { viewport, track, thumb } = renderConversation()
    thumb.getBoundingClientRect = () =>
      new DOMRect(
        392,
        3 + Number.parseFloat(thumb.style.transform.replace('translateY(', '')),
        8,
        Number.parseFloat(thumb.style.height)
      )
    viewport.scrollTop = 600
    fireEvent.scroll(viewport)
    let grabOffset = 0
    let pointerY = 0
    thumb.addEventListener('pointerdown', event => {
      grabOffset = event.clientY - thumb.getBoundingClientRect().top
    })
    track.addEventListener('pointermove', event => {
      pointerY = event.clientY
    })
    let polls = 0
    const results: Array<{ ok: boolean; value: string }> = []
    vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
      if (url.includes('/commands?')) {
        if (++polls > 1) return new Promise<Response>(() => {})
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'sample-drag',
              action: 'sampleRapidMarkdownWindowing',
              selector: '[data-testid="desktop-workbench-content"]',
              value: JSON.stringify({
                contentSelector: '[data-markdown-window-chunk]',
                scrollbarSelector: '[data-testid="desktop-workbench-scrollbar"]',
                framesPerRatio: 1,
                ratios: [0.85],
              }),
            })
          )
        )
      }
      if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
      return Promise.resolve(new Response('{}'))
    })
    void runDesktopControlClient('http://127.0.0.1:43111', 'main')
    await vi.waitFor(() => expect(frames.size).toBeGreaterThan(0))
    // Search navigation moves the thumb after the command arrives, before its first sample.
    if (phase === 'before grab') {
      viewport.scrollTop = 620
      fireEvent.scroll(viewport)
    }
    for (let frame = 0; frame < 3; frame++) {
      if (phase === 'during drag' && frame === 2) {
        contentHeight = 2400
        act(() => resizes.forEach(callback => callback()))
      }
      if (phase === 'thumb drift' && frame === 2) {
        const top = Number.parseFloat(thumb.style.transform.replace('translateY(', ''))
        thumb.style.transform = `translateY(${top + 10}px)`
      }
      flushFrame()
      await act(async () => {})
    }
    await vi.waitFor(() => expect(results).toHaveLength(1))
    expect(results[0].ok).toBe(true)
    const sample = JSON.parse(results[0].value).samples[0]
    const expectedError = phase === 'thumb drift' ? 10 : 0
    expect(Math.abs(thumb.getBoundingClientRect().top + grabOffset - pointerY)).toBeCloseTo(
      expectedError
    )
    expect(sample.scrollbarPointerError).toBeCloseTo(expectedError)
    expect(track.releasePointerCapture).toHaveBeenCalled()
  }
)

test.each(['cancel', 'capture loss', 'unmount'])('stops further drag writes on %s', reason => {
  const { viewport, track, unmount } = renderConversation()
  fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientY: 200 })
  fireEvent.pointerMove(track, { buttons: 1, pointerId: 1, clientY: 3 })
  if (reason === 'unmount') unmount()
  else if (reason === 'cancel') fireEvent.pointerCancel(track, { pointerId: 1 })
  else fireEvent.lostPointerCapture(track, { pointerId: 1 })
  fireEvent.pointerMove(track, { buttons: 1, pointerId: 1, clientY: 397 })
  flushFrame()
  expect(viewport.scrollTop).toBe(0)
  expect(frames.size).toBe(0)
})

test('synchronizes keyboard scrolling, thumb position, and content resizing', () => {
  const { viewport, track, thumb } = renderConversation()
  fireEvent.keyDown(track, { key: 'Home' })
  fireEvent.scroll(viewport)
  expect(viewport.scrollTop).toBe(0)
  expect(thumb.style.transform).toBe('translateY(0px)')
  expect(track).toHaveAttribute('aria-valuenow', '0')
  fireEvent.keyDown(track, { key: 'End' })
  expect(viewport.scrollTop).toBe(1200)

  contentHeight = 300
  act(() => resizes.forEach(callback => callback()))
  expect(track).not.toBeVisible()
  contentHeight = 2000
  act(() => resizes.forEach(callback => callback()))
  expect(track).toBeVisible()
  expect(thumb.style.height).toBe('78.8px')
  expect(track).toHaveAttribute('aria-valuemax', '1600')
})
