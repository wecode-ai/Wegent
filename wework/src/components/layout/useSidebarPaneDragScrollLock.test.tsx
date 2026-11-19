import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useSidebarPaneDragScrollLock } from './useSidebarPaneDragScrollLock'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT,
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
} from './workbenchPaneDrag'

test('locks scroll only while a dragged pane is outside the sidebar and releases on drag end', () => {
  const { result, unmount } = renderHook(useSidebarPaneDragScrollLock)
  const element = document.createElement('div')
  element.getBoundingClientRect = vi.fn(() => ({ left: 10, right: 200 }) as DOMRect)
  result.current.scrollContainerRef.current = element
  const move = (clientX: number) => window.dispatchEvent(new MouseEvent('pointermove', { clientX }))
  act(() => move(300))
  expect(result.current.dragOutsideSidebar).toBe(false)
  element.scrollTop = 40
  act(() => window.dispatchEvent(new Event(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT)))
  element.scrollTop = 50
  act(() => move(300))
  expect(result.current.dragOutsideSidebar).toBe(true)
  element.scrollTop = 90
  act(() => move(310))
  expect(element.scrollTop).toBe(50)
  act(() => move(100))
  expect(result.current.dragOutsideSidebar).toBe(false)
  element.scrollTop = 70
  act(() => move(0))
  expect(result.current.dragOutsideSidebar).toBe(true)
  act(() => window.dispatchEvent(new Event(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT)))
  expect(result.current.dragOutsideSidebar).toBe(false)
  element.scrollTop = 90
  act(() => move(0))
  expect(element.scrollTop).toBe(90)
  unmount()
})
