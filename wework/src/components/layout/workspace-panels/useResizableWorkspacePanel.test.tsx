import { act, fireEvent, render, screen } from '@testing-library/react'
import { useResizableBottomPanel } from './useResizableWorkspacePanel'

describe('useResizableBottomPanel', () => {
  test('resizes the panel imperatively without rerendering terminal content while dragging', () => {
    const frames: FrameRequestCallback[] = []
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        frames.push(callback)
        return frames.length
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined)
    let renderCount = 0

    function Harness() {
      const { height, resizing, panelRef, handleResizeStart } = useResizableBottomPanel()
      renderCount += 1

      return (
        <section ref={panelRef} data-testid="panel" style={{ height }} data-resizing={resizing}>
          <div data-testid="handle" onPointerDown={handleResizeStart} />
        </section>
      )
    }

    const { unmount } = render(<Harness />)
    fireEvent.pointerDown(screen.getByTestId('handle'), { clientY: 700 })
    expect(renderCount).toBe(2)

    fireEvent.pointerMove(document, { clientY: 660 })
    fireEvent.pointerMove(document, { clientY: 620 })
    expect(frames).toHaveLength(1)

    act(() => frames[0](performance.now()))
    expect(screen.getByTestId('panel')).toHaveStyle({ height: '400px' })
    expect(renderCount).toBe(2)

    fireEvent.pointerUp(document)
    expect(renderCount).toBe(3)
    expect(screen.getByTestId('panel')).toHaveStyle({ height: '400px' })

    fireEvent.pointerDown(screen.getByTestId('handle'), { clientY: 620 })
    expect(document.body.style.cursor).toBe('row-resize')
    unmount()
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
  })
})
