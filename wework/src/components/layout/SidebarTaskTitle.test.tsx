import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SidebarTaskTitle } from './SidebarTaskTitle'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT,
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
} from './workbenchPaneDrag'

const observers: { refresh: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
      constructor(refresh: ResizeObserverCallback) {
        observers.push({ refresh, disconnect: this.disconnect })
      }
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(300)
})
afterEach(() => {
  cleanup()
  observers.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function Title({ text = 'A long task title' }: { text?: string }) {
  return (
    <div data-sidebar-task-row data-testid="row">
      <SidebarTaskTitle text={text} testId="title" textTestId="text" />
    </div>
  )
}

test('owns hover scrolling and return animation for the mounted title', () => {
  const { unmount } = render(<Title />)
  const row = screen.getByTestId('row')
  const title = screen.getByTestId('title')
  fireEvent.pointerEnter(row)
  expect(title.dataset.scrollState).toBe('waiting')
  act(() => vi.advanceTimersByTime(599))
  expect(title.dataset.scrollState).toBe('waiting')
  act(() => vi.advanceTimersByTime(1))
  expect(title.dataset.scrollState).toBe('scrolling')
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByTestId('text').style.transform).not.toBe('translateX(0px)')
  fireEvent.pointerLeave(row)
  expect(title.dataset.scrollState).toBe('returning')
  act(() => vi.advanceTimersByTime(200))
  expect(title.dataset.scrollState).toBe('idle')
  expect(screen.getByTestId('text').style.transform).toBe('')
  expect(observers[0].disconnect).toHaveBeenCalled()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test('refreshes changed text in place and ignores detached observer callbacks', async () => {
  const { rerender, unmount } = render(<Title />)
  fireEvent.pointerEnter(screen.getByTestId('row'))
  act(() => vi.advanceTimersByTime(800))
  const previous = observers[0]
  const originalText = screen.getByTestId('text')
  await act(async () => rerender(<Title text="Replacement title" />))
  expect(screen.getByTestId('text')).toBe(originalText)
  expect(originalText.style.transform).toBe('translateX(0px)')
  expect(screen.getByTestId('title').dataset.scrollState).toBe('waiting')
  fireEvent.pointerDown(screen.getByTestId('row'))
  expect(screen.getByTestId('title').dataset.scrollState).toBe('idle')
  fireEvent.pointerUp(window)
  expect(screen.getByTestId('title').dataset.scrollState).toBe('waiting')
  unmount()
  expect(previous.disconnect).toHaveBeenCalled()
  act(() => previous.refresh([], {} as ResizeObserver))
  expect(vi.getTimerCount()).toBe(0)
})

test('pauses during pane dragging and releases the shared drag listeners after unmount', () => {
  const { unmount } = render(<Title />)
  const title = screen.getByTestId('title')
  fireEvent.pointerEnter(screen.getByTestId('row'))
  act(() => window.dispatchEvent(new Event(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT)))
  expect(title.dataset.scrollState).toBe('idle')
  expect(vi.getTimerCount()).toBe(0)
  act(() => window.dispatchEvent(new Event(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT)))
  expect(title.dataset.scrollState).toBe('waiting')
  unmount()
  act(() => window.dispatchEvent(new Event(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT)))
  expect(vi.getTimerCount()).toBe(0)
})
