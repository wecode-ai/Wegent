export const SELECTED_TEXT_DRAG_TYPE = 'application/x-wework-selected-text'
export const SELECTED_TEXT_CHANGED_EVENT = 'wework:selected-text-changed'

export interface SelectedTextChangedDetail {
  source: string
  text: string | null
  rect: SelectedTextRect | null
}

export interface SelectedTextRect {
  left: number
  top: number
  width: number
  height: number
}

export function hasSelectedTextDragData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types ?? []).includes(SELECTED_TEXT_DRAG_TYPE)
}

export function publishSelectedTextSelection(
  source: string,
  text: string | null,
  rect: SelectedTextRect | null = null
): void {
  const normalizedText = text?.trim() ? text : null
  window.dispatchEvent(
    new CustomEvent<SelectedTextChangedDetail>(SELECTED_TEXT_CHANGED_EVENT, {
      detail: { source, text: normalizedText, rect: normalizedText ? rect : null },
    })
  )
}

export function writeSelectedTextDragData(dataTransfer: DataTransfer, text: string): boolean {
  if (!text) return false
  dataTransfer.setData('text/plain', text)
  dataTransfer.setData(SELECTED_TEXT_DRAG_TYPE, 'true')
  dataTransfer.effectAllowed = 'copy'
  return true
}

function selectionBelongsToDragSource(selection: Selection, source: EventTarget | null): boolean {
  if (!(source instanceof Node) || !selection.anchorNode || !selection.focusNode) return false

  const composedContains = (ancestor: Node, descendant: Node) => {
    let current: Node | null = descendant
    while (current) {
      if (current === ancestor) return true
      const root = current.getRootNode()
      current =
        current.parentNode ?? (root instanceof ShadowRoot && root !== current ? root.host : null)
    }
    return false
  }
  const element = source instanceof Element ? source : source.parentElement
  return Boolean(
    selection.containsNode(source, true) ||
    (element &&
      composedContains(element, selection.anchorNode) &&
      composedContains(element, selection.focusNode))
  )
}

export function prepareSelectedTextDrag(event: DragEvent): string | null {
  const dataTransfer = event.dataTransfer
  if (!dataTransfer) return null

  if (Array.from(dataTransfer.types ?? []).includes(SELECTED_TEXT_DRAG_TYPE)) {
    return dataTransfer.getData('text/plain') || null
  }

  const selection = window.getSelection()
  if (
    !selection ||
    selection.isCollapsed ||
    !selectionBelongsToDragSource(selection, event.target)
  ) {
    return null
  }

  const text = selection.toString()
  return writeSelectedTextDragData(dataTransfer, text) ? text : null
}
