// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useResizableSidebar } from './useResizableSidebar'

it('releases the embedded browser shield and pending SDK drag when its sidebar unmounts', async () => {
  const storageKey = 'wework.desktop.sidebar.width'
  const previousWidth = localStorage.getItem(storageKey)
  const previousCursor = document.body.style.cursor
  const previousSelection = document.body.style.userSelect
  const changed = vi.fn()
  function Sidebar() {
    const { handleResizeStart } = useResizableSidebar({ onResizeStateChange: changed })
    return (
      <button type="button" onPointerDown={handleResizeStart}>
        Resize
      </button>
    )
  }
  const view = render(<Sidebar />)
  try {
    fireEvent.pointerDown(view.getByRole('button'), { button: 0, pointerId: 1, clientX: 260 })
    expect(document.body.getAttribute('data-wework-panel-resizing')).toBe('true')
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 320 })
    await waitFor(() => expect(localStorage.getItem(storageKey)).toBe('320'))
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 360 })
    view.unmount()
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(localStorage.getItem(storageKey)).toBe('320')
    expect(document.body.hasAttribute('data-wework-panel-resizing')).toBe(false)
    expect(document.body.style.cursor).toBe(previousCursor)
    expect(document.body.style.userSelect).toBe(previousSelection)
    expect(changed).toHaveBeenLastCalledWith(false)
  } finally {
    view.unmount()
    if (previousWidth === null) localStorage.removeItem(storageKey)
    else localStorage.setItem(storageKey, previousWidth)
  }
})

it('flushes the final SDK drag position before committing the bottom panel height', async () => {
  const { useResizableBottomPanel } = await import('./workspace-panels/useResizableWorkspacePanel')
  function BottomPanel() {
    const { height, panelRef, handleResizeStart } = useResizableBottomPanel()
    return (
      <section ref={panelRef} data-testid="resized-panel" data-height={height}>
        <button type="button" onPointerDown={handleResizeStart}>
          Resize bottom
        </button>
      </section>
    )
  }
  const view = render(<BottomPanel />)
  try {
    fireEvent.pointerDown(view.getByRole('button'), { button: 0, pointerId: 2, clientY: 500 })
    fireEvent.pointerMove(document, { pointerId: 2, clientY: 450 })
    fireEvent.pointerUp(document, { pointerId: 2, clientY: 450 })
    expect(view.getByTestId('resized-panel').getAttribute('data-height')).toBe('370')
    expect(view.getByTestId('resized-panel').style.flexBasis).toBe('370px')
    expect(document.body.hasAttribute('data-wework-panel-resizing')).toBe(false)
  } finally {
    view.unmount()
  }
})

it('does not persist a canceled right-panel drag and releases its shield on unmount', async () => {
  const { useResizableRightSplitChat } =
    await import('./workspace-panels/useResizableWorkspacePanel')
  const storageKey = 'wework.desktop.right-workspace.panel-width-ratio'
  const previousRatio = localStorage.getItem(storageKey)
  function RightPanel() {
    const { handleResizeStart } = useResizableRightSplitChat()
    return (
      <button type="button" onPointerDown={handleResizeStart}>
        Resize right
      </button>
    )
  }
  const view = render(<RightPanel />)
  try {
    fireEvent.pointerDown(view.getByRole('button'), { button: 0, pointerId: 3, clientX: 500 })
    fireEvent.pointerMove(document, { pointerId: 3, clientX: 450 })
    fireEvent.pointerCancel(document, { pointerId: 3, clientX: 450 })
    expect(localStorage.getItem(storageKey)).toBe(previousRatio)
    expect(document.body.hasAttribute('data-wework-panel-resizing')).toBe(false)
    fireEvent.pointerDown(view.getByRole('button'), { button: 0, pointerId: 4, clientX: 500 })
    fireEvent.pointerMove(document, { pointerId: 4, clientX: 430 })
    view.unmount()
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(localStorage.getItem(storageKey)).toBe(previousRatio)
    expect(document.body.hasAttribute('data-wework-panel-resizing')).toBe(false)
  } finally {
    view.unmount()
  }
})
