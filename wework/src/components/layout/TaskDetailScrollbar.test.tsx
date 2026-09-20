import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TaskDetailScrollArea } from './TaskDetailScrollArea'

let contentHeight = 1600
const resizes = new Set<() => void>()

beforeEach(() => {
  contentHeight = 1600
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
  render(
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
  // Match Chromium's flex-column-reverse scroll range: positive writes clamp to zero.
  let position = 0
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => position,
    set: value => {
      position = Math.max(400 - contentHeight, Math.min(0, value))
    },
  })
  return { viewport, track, thumb: screen.getByTestId('desktop-workbench-scrollbar-thumb') }
}

test('maps track clicks and continuous dragging to the negative conversation scroll range', () => {
  const { viewport, track, thumb } = renderConversation()
  expect(thumb.style.height).toBe('98.5px')
  expect(thumb.style.transform).toBe('translateY(295.5px)')

  fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientY: 200 })
  expect(viewport.scrollTop).toBe(-600)
  fireEvent.pointerMove(track, { buttons: 1, pointerId: 1, clientY: 3 })
  expect(viewport.scrollTop).toBe(-1200)
  fireEvent.pointerMove(track, { buttons: 1, pointerId: 1, clientY: 397 })
  expect(viewport.scrollTop).toBe(0)
  fireEvent.pointerUp(track, { pointerId: 1 })
  fireEvent.pointerMove(track, { pointerId: 1, clientY: 3 })
  expect(viewport.scrollTop).toBe(0)
})

test('synchronizes keyboard scrolling, thumb position, and content resizing', () => {
  const { viewport, track, thumb } = renderConversation()
  fireEvent.keyDown(track, { key: 'Home' })
  fireEvent.scroll(viewport)
  expect(viewport.scrollTop).toBe(-1200)
  expect(thumb.style.transform).toBe('translateY(0px)')
  expect(track).toHaveAttribute('aria-valuenow', '0')
  fireEvent.keyDown(track, { key: 'End' })
  expect(viewport.scrollTop).toBe(0)

  contentHeight = 300
  act(() => resizes.forEach(callback => callback()))
  expect(track).not.toBeVisible()
  contentHeight = 2000
  act(() => resizes.forEach(callback => callback()))
  expect(track).toBeVisible()
  expect(thumb.style.height).toBe('78.8px')
  expect(track).toHaveAttribute('aria-valuemax', '1600')
})
