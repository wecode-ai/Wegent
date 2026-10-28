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

test('coalesces pointer moves into one scroll write per frame and flushes the release position', () => {
  const { viewport, track } = renderConversation()
  const writes = vi.spyOn(viewport, 'scrollTop', 'set')
  fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientY: 200 })
  writes.mockClear()

  for (let clientY = 210; clientY <= 300; clientY += 10) {
    fireEvent.pointerMove(track, { buttons: 1, pointerId: 1, clientY })
  }
  expect(writes).not.toHaveBeenCalled()
  expect(frames.size).toBe(1)
  flushFrame()
  expect(writes).toHaveBeenCalledOnce()
  expect(viewport.scrollTop).toBeCloseTo(1006.0914)

  fireEvent.pointerMove(track, { buttons: 1, pointerId: 1, clientY: 397 })
  fireEvent.pointerUp(track, { pointerId: 1 })
  expect(viewport.scrollTop).toBe(1200)
  expect(writes).toHaveBeenCalledTimes(2)
  expect(frames.size).toBe(0)
  flushFrame()
  expect(writes).toHaveBeenCalledTimes(2)
})

test('keeps the grabbed thumb point under the pointer while measured content changes', () => {
  const { viewport, track, thumb } = renderConversation()
  fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientY: 200 })
  fireEvent.scroll(viewport)
  const initialThumbTop = Number.parseFloat(thumb.style.transform.replace('translateY(', ''))
  expect(viewport.scrollTop).toBe(600)

  for (const height of [2400, 1200, 2000]) {
    contentHeight = height
    act(() => resizes.forEach(callback => callback()))
    const top = Number.parseFloat(thumb.style.transform.replace('translateY(', ''))
    expect(top).toBeCloseTo(initialThumbTop)
    expect(viewport.scrollTop).toBeCloseTo((600 * height) / 1600)
  }
  fireEvent.pointerUp(track, { pointerId: 1 })
  const releasedTop = viewport.scrollTop
  contentHeight = 3200
  act(() => resizes.forEach(callback => callback()))
  expect(viewport.scrollTop).toBe(releasedTop)
})

test.each(['cancel', 'capture loss', 'unmount'])('discards a pending drag on %s', reason => {
  const { viewport, track, unmount } = renderConversation()
  fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientY: 200 })
  fireEvent.pointerMove(track, { buttons: 1, pointerId: 1, clientY: 3 })
  if (reason === 'unmount') unmount()
  else if (reason === 'cancel') fireEvent.pointerCancel(track, { pointerId: 1 })
  else fireEvent.lostPointerCapture(track, { pointerId: 1 })
  flushFrame()
  expect(viewport.scrollTop).toBe(600)
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
