import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarSortableList } from './SidebarSortableList'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
  type WorkbenchSidebarPaneDragEndData,
} from './workbenchPaneDrag'

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
  it('cancels an active pane drag when the sortable list unmounts', async () => {
    const dragEndDetails: Array<WorkbenchSidebarPaneDragEndData | null> = []
    const handleExternalDragEnd = (event: Event) => {
      dragEndDetails.push((event as CustomEvent<WorkbenchSidebarPaneDragEndData | null>).detail)
    }
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleExternalDragEnd)

    try {
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
    } finally {
      fireEvent.pointerUp(document, {
        button: 0,
        buttons: 0,
        clientX: 24,
        clientY: 30,
        isPrimary: true,
        pointerId: 1,
      })
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleExternalDragEnd)
      await waitForPointerSensorCleanup()
    }
  })

  it('keeps pane drag available without reordering a non-sortable task list', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined)
    const dragEndDetails: WorkbenchSidebarPaneDragEndData[] = []
    const handleExternalDragEnd = (event: Event) => {
      dragEndDetails.push((event as CustomEvent<WorkbenchSidebarPaneDragEndData>).detail)
    }
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleExternalDragEnd)
    try {
      render(
        <SidebarSortableList
          items={items}
          getId={item => item.id}
          getLabel={item => item.label}
          getExternalDragData={item => ({ paneKey: `pane:${item.id}`, title: item.label })}
          onMove={onMove}
          sortable={false}
          testId="fixed-list"
          renderItem={item => (
            <span data-testid={`fixed-activator-${item.id}`} data-sidebar-drag-activator>
              {item.label}
            </span>
          )}
        />
      )

      const firstItem = screen.getByTestId('fixed-activator-first').parentElement as HTMLElement
      mockRect(firstItem, 0)
      expect(firstItem).toHaveAttribute('data-pane-drag-id', 'first')
      expect(firstItem).not.toHaveAttribute('data-sidebar-sortable-id')
      expect(firstItem).not.toHaveAttribute('role')
      expect(firstItem).not.toHaveAttribute('tabindex')
      fireEvent.pointerDown(screen.getByTestId('fixed-activator-first'), {
        button: 0,
        buttons: 1,
        clientX: 12,
        clientY: 15,
        isPrimary: true,
        pointerId: 2,
      })
      fireEvent.pointerMove(document, {
        buttons: 1,
        clientX: 24,
        clientY: 30,
        isPrimary: true,
        pointerId: 2,
      })
      expect(firstItem).toHaveAttribute('data-dragging', 'true')
      fireEvent.pointerUp(document, {
        button: 0,
        buttons: 0,
        clientX: 24,
        clientY: 30,
        isPrimary: true,
        pointerId: 2,
      })

      expect(onMove).not.toHaveBeenCalled()
      expect(dragEndDetails.at(-1)).toEqual(
        expect.objectContaining({ paneKey: 'pane:first', clientX: 24, clientY: 30 })
      )
    } finally {
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleExternalDragEnd)
      await waitForPointerSensorCleanup()
    }
  })
})
