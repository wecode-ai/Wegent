import { afterEach, describe, expect, test, vi } from 'vitest'
import { installXtermSelectionGuard } from './xtermSelectionGuard'

function dispatchMouseEvent(target: EventTarget, type: string, init: MouseEventInit = {}) {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      ...init,
    })
  )
}

describe('installXtermSelectionGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('sends mouseup to terminal when the button was released outside the WebView', () => {
    const container = document.createElement('div')
    const clearSelection = vi.fn()
    const mouseUpListener = vi.fn()
    const guard = installXtermSelectionGuard({
      container,
      terminal: { clearSelection },
    })
    container.addEventListener('mouseup', mouseUpListener)

    dispatchMouseEvent(container, 'mousedown', { button: 0, buttons: 1 })
    dispatchMouseEvent(window, 'mousemove', { buttons: 0, clientX: 12, clientY: 18 })

    expect(mouseUpListener).toHaveBeenCalledTimes(1)
    expect(mouseUpListener.mock.calls[0][0]).toMatchObject({
      button: 0,
      buttons: 0,
      clientX: 12,
      clientY: 18,
    })
    expect(clearSelection).not.toHaveBeenCalled()

    guard.dispose()
  })

  test('does not interfere with active drag selection', () => {
    const container = document.createElement('div')
    const clearSelection = vi.fn()
    const mouseUpListener = vi.fn()
    const guard = installXtermSelectionGuard({
      container,
      terminal: { clearSelection },
    })
    container.addEventListener('mouseup', mouseUpListener)

    dispatchMouseEvent(container, 'mousedown', { button: 0, buttons: 1 })
    dispatchMouseEvent(window, 'mousemove', { buttons: 1 })

    expect(mouseUpListener).not.toHaveBeenCalled()
    expect(clearSelection).not.toHaveBeenCalled()

    guard.dispose()
  })

  test('clears abandoned drag selection when the window loses focus', () => {
    const container = document.createElement('div')
    const clearSelection = vi.fn()
    const guard = installXtermSelectionGuard({
      container,
      terminal: { clearSelection },
    })

    dispatchMouseEvent(container, 'mousedown', { button: 0, buttons: 1 })
    window.dispatchEvent(new Event('blur'))

    expect(clearSelection).toHaveBeenCalledTimes(1)

    guard.dispose()
  })

  test('detaches listeners on dispose', () => {
    const container = document.createElement('div')
    const clearSelection = vi.fn()
    const mouseUpListener = vi.fn()
    const guard = installXtermSelectionGuard({
      container,
      terminal: { clearSelection },
    })
    container.addEventListener('mouseup', mouseUpListener)

    dispatchMouseEvent(container, 'mousedown', { button: 0, buttons: 1 })
    guard.dispose()
    dispatchMouseEvent(window, 'mousemove', { buttons: 0 })
    window.dispatchEvent(new Event('blur'))

    expect(mouseUpListener).not.toHaveBeenCalled()
    expect(clearSelection).not.toHaveBeenCalled()
  })
})
