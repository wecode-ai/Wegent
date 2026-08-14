import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
  type WorkbenchSidebarPaneDragEndData,
} from './workbenchPaneDrag'
import { getSidebarAutoScrollConfiguration } from './sidebarSortableAutoScroll'
import { SidebarSortableList } from './SidebarSortableList'

interface Item {
  id: string
  label: string
}

const items: Item[] = [
  { id: 'first', label: 'First' },
  { id: 'second', label: 'Second' },
]

function mockRect(element: HTMLElement, top: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 240,
    bottom: top + 30,
    width: 240,
    height: 30,
    toJSON: () => ({}),
  } as DOMRect)
}

async function waitForPointerSensorCleanup() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 60))
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SidebarSortableList', () => {
  it('disables both dnd-kit scroll paths for task drags that can leave the sidebar', () => {
    expect(getSidebarAutoScrollConfiguration(true)).toEqual({
      enabled: false,
      layoutShiftCompensation: false,
    })
    expect(getSidebarAutoScrollConfiguration(false)).toEqual({ enabled: true })
  })

  it('stops sidebar sorting and reports the real pointer position outside the sidebar', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined)
    const dragEndDetails: WorkbenchSidebarPaneDragEndData[] = []
    const handleExternalDragEnd = (event: Event) => {
      const detail = (event as CustomEvent<WorkbenchSidebarPaneDragEndData | null>).detail
      if (detail) dragEndDetails.push(detail)
    }
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleExternalDragEnd)

    render(
      <div data-testid="scroll-container" className="overflow-y-auto">
        <SidebarSortableList
          items={items}
          getId={item => item.id}
          getLabel={item => item.label}
          getExternalDragData={item => ({ paneKey: `pane:${item.id}`, title: item.label })}
          onMove={onMove}
          testId="sortable-list"
          renderItem={item => (
            <div data-testid={`item-${item.id}`}>
              <span data-testid={`activator-${item.id}`} data-sidebar-drag-activator>
                {item.label}
              </span>
            </div>
          )}
        />
      </div>
    )

    const scrollContainer = screen.getByTestId('scroll-container')
    const firstSortable = screen.getByTestId('item-first').parentElement as HTMLElement
    const secondSortable = screen.getByTestId('item-second').parentElement as HTMLElement
    const scrollBy = vi.fn()
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 60 },
      clientWidth: { configurable: true, value: 240 },
      scrollHeight: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 240 },
      scrollBy: { configurable: true, value: scrollBy },
    })
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 240,
      bottom: 60,
      width: 240,
      height: 60,
      toJSON: () => ({}),
    } as DOMRect)
    mockRect(firstSortable, 0)
    mockRect(secondSortable, 30)

    fireEvent.pointerDown(screen.getByTestId('activator-first'), {
      button: 0,
      buttons: 1,
      clientX: 12,
      clientY: 15,
      isPrimary: true,
      pointerId: 1,
    })
    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 12,
      clientY: 45,
      isPrimary: true,
      pointerId: 1,
    })
    expect(firstSortable).toHaveAttribute('data-dragging', 'true')

    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 640,
      clientY: 59,
      isPrimary: true,
      pointerId: 1,
    })

    await waitFor(() => {
      expect(firstSortable.style.transform).toBe('')
      expect(secondSortable.style.transform).toBe('')
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect(scrollBy).not.toHaveBeenCalled()

    fireEvent.pointerUp(document, {
      button: 0,
      buttons: 0,
      clientX: 640,
      clientY: 59,
      isPrimary: true,
      pointerId: 1,
    })

    await waitFor(() => expect(dragEndDetails).toHaveLength(1))
    expect(dragEndDetails[0]).toMatchObject({
      paneKey: 'pane:first',
      clientX: 640,
      clientY: 59,
    })
    expect(onMove).not.toHaveBeenCalled()

    window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleExternalDragEnd)
    await waitForPointerSensorCleanup()
  })

  it('cancels an active pane drag when the sortable list unmounts', async () => {
    const dragEndDetails: Array<WorkbenchSidebarPaneDragEndData | null> = []
    const handleExternalDragEnd = (event: Event) => {
      dragEndDetails.push((event as CustomEvent<WorkbenchSidebarPaneDragEndData | null>).detail)
    }
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleExternalDragEnd)

    const view = render(
      <SidebarSortableList
        items={items}
        getId={item => item.id}
        getLabel={item => item.label}
        getExternalDragData={item => ({ paneKey: `pane:${item.id}`, title: item.label })}
        onMove={vi.fn().mockResolvedValue(undefined)}
        testId="sortable-list"
        renderItem={item => (
          <span data-testid={`activator-${item.id}`} data-sidebar-drag-activator>
            {item.label}
          </span>
        )}
      />
    )

    const firstSortable = screen.getByTestId('activator-first').parentElement as HTMLElement
    mockRect(firstSortable, 0)
    fireEvent.pointerDown(screen.getByTestId('activator-first'), {
      button: 0,
      buttons: 1,
      clientX: 12,
      clientY: 15,
      isPrimary: true,
      pointerId: 1,
    })
    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 24,
      clientY: 30,
      isPrimary: true,
      pointerId: 1,
    })
    expect(firstSortable).toHaveAttribute('data-dragging', 'true')

    view.unmount()

    expect(dragEndDetails).toEqual([null])
    window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleExternalDragEnd)
    await waitForPointerSensorCleanup()
  })
})
