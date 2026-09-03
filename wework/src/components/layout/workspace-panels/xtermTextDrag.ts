import type { Terminal } from '@xterm/xterm'
import { publishSelectedTextSelection, writeSelectedTextDragData } from '@/lib/selected-text-drag'

type XtermTextDragOptions = {
  container: HTMLElement
  terminal: Pick<
    Terminal,
    | 'buffer'
    | 'clearSelection'
    | 'cols'
    | 'focus'
    | 'getSelection'
    | 'getSelectionPosition'
    | 'hasSelection'
    | 'input'
    | 'onResize'
    | 'onScroll'
    | 'onSelectionChange'
    | 'rows'
    | 'select'
  >
}

export type XtermTextDragController = {
  dispose: () => void
}

type XtermAutomationContainer = HTMLElement & {
  __weworkInputForE2E?: (value: string) => void
  __weworkTextForE2E?: () => string
  __weworkSelectTextForE2E?: (value: string) => string
}

export function readXtermBufferText(terminal: Pick<Terminal, 'buffer'>): string {
  const buffer = terminal.buffer.active
  return Array.from(
    { length: buffer.length },
    (_, row) => buffer.getLine(row)?.translateToString(true) ?? ''
  ).join('\n')
}

export function selectXtermBufferText(
  terminal: Pick<Terminal, 'buffer' | 'getSelection' | 'select'>,
  value: string
): string {
  const buffer = terminal.buffer.active
  for (let row = buffer.length - 1; row >= 0; row -= 1) {
    const lineText = buffer.getLine(row)?.translateToString(true) ?? ''
    const column = lineText.lastIndexOf(value)
    if (column < 0) continue
    terminal.select(column, row, value.length)
    return terminal.getSelection()
  }
  return ''
}

function createDragRegion(
  overlay: HTMLElement,
  terminal: XtermTextDragOptions['terminal'],
  left: number,
  top: number,
  width: number,
  height: number
) {
  if (width <= 0 || height <= 0) return

  const region = document.createElement('div')
  region.dataset.testid = 'xterm-selection-drag-region'
  region.draggable = true
  Object.assign(region.style, {
    cursor: 'grab',
    height: `${height}px`,
    left: `${left}px`,
    pointerEvents: 'auto',
    position: 'absolute',
    top: `${top}px`,
    width: `${width}px`,
  })
  region.addEventListener('mousedown', event => {
    if (event.button === 0) event.stopPropagation()
  })
  region.addEventListener('click', event => {
    event.stopPropagation()
    terminal.clearSelection()
    terminal.focus()
  })
  region.addEventListener('dragstart', event => {
    if (!event.dataTransfer || !terminal.hasSelection()) return
    writeSelectedTextDragData(event.dataTransfer, terminal.getSelection())
  })
  overlay.append(region)
}

export function installXtermTextDrag({
  container,
  terminal,
}: XtermTextDragOptions): XtermTextDragController {
  const selectionSource = `terminal:${crypto.randomUUID()}`
  let selectingWithMouse = false
  let syncFrame = 0
  const screen = container.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) {
    return { dispose: () => undefined }
  }

  const overlay = document.createElement('div')
  overlay.dataset.testid = 'xterm-selection-drag-overlay'
  Object.assign(overlay.style, {
    inset: '0',
    pointerEvents: 'none',
    position: 'absolute',
    zIndex: '9',
  })
  screen.append(overlay)

  const syncDragRegions = () => {
    overlay.replaceChildren()
    const selection = terminal.getSelectionPosition()
    const selectedText = terminal.hasSelection() ? terminal.getSelection() : ''
    if (
      selectingWithMouse ||
      !selectedText ||
      !selection ||
      terminal.cols <= 0 ||
      terminal.rows <= 0
    ) {
      publishSelectedTextSelection(selectionSource, selectedText)
      return
    }

    const screenRect = screen.getBoundingClientRect()
    const { height, width } = screenRect
    if (height <= 0 || width <= 0) return
    const cellWidth = width / terminal.cols
    const cellHeight = height / terminal.rows
    const viewportY = terminal.buffer.active.viewportY
    const startRow = selection.start.y - 1 - viewportY
    const endRow = selection.end.y - 1 - viewportY
    const firstVisibleRow = Math.max(0, startRow)
    const lastVisibleRow = Math.min(terminal.rows - 1, endRow)
    let selectionLeft = Number.POSITIVE_INFINITY
    let selectionTop = Number.POSITIVE_INFINITY
    let selectionRight = Number.NEGATIVE_INFINITY
    let selectionBottom = Number.NEGATIVE_INFINITY

    for (let row = firstVisibleRow; row <= lastVisibleRow; row += 1) {
      const startColumn = row === startRow ? selection.start.x - 1 : 0
      const endColumn = row === endRow ? selection.end.x - 1 : terminal.cols
      const left = Math.max(0, startColumn) * cellWidth
      const top = row * cellHeight
      const regionWidth =
        (Math.min(terminal.cols, endColumn) - Math.max(0, startColumn)) * cellWidth
      createDragRegion(overlay, terminal, left, top, regionWidth, cellHeight)
      if (regionWidth > 0) {
        selectionLeft = Math.min(selectionLeft, left)
        selectionTop = Math.min(selectionTop, top)
        selectionRight = Math.max(selectionRight, left + regionWidth)
        selectionBottom = Math.max(selectionBottom, top + cellHeight)
      }
    }
    publishSelectedTextSelection(
      selectionSource,
      selectedText,
      Number.isFinite(selectionLeft)
        ? {
            left: screenRect.left + selectionLeft,
            top: screenRect.top + selectionTop,
            width: selectionRight - selectionLeft,
            height: selectionBottom - selectionTop,
          }
        : null
    )
  }

  const handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    if (
      event.target instanceof Element &&
      event.target.closest('[data-testid="xterm-selection-drag-region"]')
    )
      return
    selectingWithMouse = true
    overlay.replaceChildren()
  }
  const handleMouseUp = () => {
    if (!selectingWithMouse) return
    selectingWithMouse = false
    window.cancelAnimationFrame(syncFrame)
    syncFrame = window.requestAnimationFrame(syncDragRegions)
  }

  const disposables = [
    terminal.onSelectionChange(syncDragRegions),
    terminal.onScroll(syncDragRegions),
    terminal.onResize(syncDragRegions),
  ]
  const automationContainer = container as XtermAutomationContainer
  const selectTextForE2E = (value: string) => {
    const selectedText = selectXtermBufferText(terminal, value)
    syncDragRegions()
    return selectedText
  }
  const readTextForE2E = () => readXtermBufferText(terminal)
  automationContainer.__weworkInputForE2E = value => terminal.input(value)
  automationContainer.__weworkTextForE2E = readTextForE2E
  automationContainer.__weworkSelectTextForE2E = selectTextForE2E
  container.addEventListener('mousedown', handleMouseDown, true)
  window.addEventListener('mouseup', handleMouseUp, true)
  syncDragRegions()

  return {
    dispose: () => {
      window.cancelAnimationFrame(syncFrame)
      publishSelectedTextSelection(selectionSource, null)
      disposables.forEach(disposable => disposable.dispose())
      container.removeEventListener('mousedown', handleMouseDown, true)
      window.removeEventListener('mouseup', handleMouseUp, true)
      if (automationContainer.__weworkSelectTextForE2E === selectTextForE2E) {
        delete automationContainer.__weworkSelectTextForE2E
      }
      if (automationContainer.__weworkTextForE2E === readTextForE2E) {
        delete automationContainer.__weworkTextForE2E
      }
      delete automationContainer.__weworkInputForE2E
      overlay.remove()
    },
  }
}
