import { type SelectedTextRect, writeSelectedTextDragData } from '@/lib/selected-text-drag'

function findSelectedLines(root: Document | ShadowRoot | HTMLElement): HTMLElement[] {
  const selectedLines = Array.from(
    root.querySelectorAll<HTMLElement>('[data-line][data-selected-line]')
  )
  root.querySelectorAll<HTMLElement>('*').forEach(element => {
    if (element.shadowRoot) selectedLines.push(...findSelectedLines(element.shadowRoot))
  })
  return selectedLines
}

function selectedLinesRect(lines: HTMLElement[]): SelectedTextRect | null {
  const rects = lines
    .map(line => line.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0)
  if (rects.length === 0) return null

  const left = Math.min(...rects.map(rect => rect.left))
  const top = Math.min(...rects.map(rect => rect.top))
  const right = Math.max(...rects.map(rect => rect.right))
  const bottom = Math.max(...rects.map(rect => rect.bottom))
  return { left, top, width: right - left, height: bottom - top }
}

export function installCodeViewTextDrag(
  host: HTMLElement,
  text: string,
  onSelectionRectChange?: (rect: SelectedTextRect | null) => void
): () => void {
  const listeners = new Map<HTMLElement, (event: DragEvent) => void>()

  const sync = () => {
    const selectedLines = new Set(findSelectedLines(host))
    listeners.forEach((listener, line) => {
      if (selectedLines.has(line)) return
      line.removeEventListener('dragstart', listener)
      line.removeAttribute('draggable')
      delete line.dataset.testid
      listeners.delete(line)
    })
    selectedLines.forEach(line => {
      if (listeners.has(line)) return
      const handleDragStart = (event: DragEvent) => {
        if (event.dataTransfer) writeSelectedTextDragData(event.dataTransfer, text)
      }
      line.draggable = true
      line.dataset.testid = 'workspace-preview-selection-drag-region'
      line.addEventListener('dragstart', handleDragStart)
      listeners.set(line, handleDragStart)
    })
    onSelectionRectChange?.(selectedLinesRect([...selectedLines]))
  }

  const observer = new MutationObserver(sync)
  observer.observe(host, { childList: true, subtree: true })
  const frame = window.requestAnimationFrame(sync)

  return () => {
    window.cancelAnimationFrame(frame)
    observer.disconnect()
    listeners.forEach((listener, line) => {
      line.removeEventListener('dragstart', listener)
      line.removeAttribute('draggable')
      delete line.dataset.testid
    })
    onSelectionRectChange?.(null)
  }
}
