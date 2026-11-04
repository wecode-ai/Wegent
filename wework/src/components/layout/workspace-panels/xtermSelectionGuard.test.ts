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
