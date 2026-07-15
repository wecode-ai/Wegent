import type { Terminal } from '@xterm/xterm'

type XtermSelectionGuardOptions = {
  container: HTMLElement
  terminal: Pick<Terminal, 'clearSelection'>
}

export type XtermSelectionGuardController = {
  dispose: () => void
}

export function installXtermSelectionGuard({
  container,
  terminal,
}: XtermSelectionGuardOptions): XtermSelectionGuardController {
  let mouseDownInTerminal = false

  const endDrag = () => {
    mouseDownInTerminal = false
  }

  const dispatchTerminalMouseUp = (event: MouseEvent) => {
    container.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: event.button,
        buttons: 0,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
      })
    )
  }

  const handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    mouseDownInTerminal = true
  }

  const handleMouseMove = (event: MouseEvent) => {
    if (!mouseDownInTerminal || event.buttons !== 0) return

    endDrag()
    dispatchTerminalMouseUp(event)
  }

  const clearAbandonedSelection = () => {
    if (!mouseDownInTerminal) return

    endDrag()
    terminal.clearSelection()
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      clearAbandonedSelection()
    }
  }

  container.addEventListener('mousedown', handleMouseDown, true)
  window.addEventListener('mouseup', endDrag, true)
  window.addEventListener('mousemove', handleMouseMove, true)
  window.addEventListener('blur', clearAbandonedSelection)
  document.addEventListener('visibilitychange', handleVisibilityChange)

  return {
    dispose: () => {
      container.removeEventListener('mousedown', handleMouseDown, true)
      window.removeEventListener('mouseup', endDrag, true)
      window.removeEventListener('mousemove', handleMouseMove, true)
      window.removeEventListener('blur', clearAbandonedSelection)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    },
  }
}
