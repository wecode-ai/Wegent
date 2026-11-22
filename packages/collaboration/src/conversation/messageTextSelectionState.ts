import { readConversationSearchContent } from './conversationSearchHighlightBinding'

export interface MessageSelectionContext {
  messageId: string
  content: string
  start: number
}

interface MessageTextSelection extends MessageSelectionContext {
  text: string
  left: number
  top: number
  conversationKey?: string | number | null
}
interface SelectionSnapshot {
  isTextSelectionActive: boolean
  textSelection: MessageTextSelection | null
}
const SELECTION_ACTION_GAP = 8

/** The actual document Selection drives both content visibility and its action toolbar. */
export function createMessageTextSelectionState(
  conversationKey: string | number | null | undefined,
  useContentVisibility: boolean,
  hasSelectionActions: boolean
) {
  let element: HTMLDivElement | null = null
  let lease: symbol | null = null
  let frame: number | null = null
  let snapshot: SelectionSnapshot = {
    isTextSelectionActive: false,
    textSelection: null,
  }
  const listeners = new Set<() => void>()
  const attached = () => lease !== null && element?.isConnected === true
  function publish(change: Partial<SelectionSnapshot>) {
    const next = { ...snapshot, ...change }
    const previousText = snapshot.textSelection
    const nextText = next.textSelection
    if (
      next.isTextSelectionActive === snapshot.isTextSelectionActive &&
      (previousText === nextText ||
        (previousText &&
          nextText &&
          previousText.text === nextText.text &&
          previousText.messageId === nextText.messageId &&
          previousText.content === nextText.content &&
          previousText.start === nextText.start &&
          previousText.left === nextText.left &&
          previousText.top === nextText.top &&
          previousText.conversationKey === nextText.conversationKey))
    )
      return
    snapshot = next
    for (const listener of listeners) listener()
  }
  function update(preserveCapturedSelection = false, eventTarget?: EventTarget | null) {
    if (!attached()) return
    if (
      isEditableSelectionTarget(eventTarget) ||
      isEditableSelectionTarget(document.activeElement)
    ) {
      publish({ isTextSelectionActive: false })
      publish({ textSelection: null })
      return
    }
    const selection = document.getSelection?.()
    const root = element
    if (!selection || !root || selection.isCollapsed || selection.rangeCount === 0) {
      publish({ isTextSelectionActive: false })
      if (!preserveCapturedSelection) {
        publish({ textSelection: null })
      }
      return
    }

    const selectionTouchesList =
      isNodeInsideElement(selection.anchorNode, root) ||
      isNodeInsideElement(selection.focusNode, root)
    if (!selectionTouchesList) {
      publish({ isTextSelectionActive: false })
      publish({ textSelection: null })
      return
    }
    publish({ isTextSelectionActive: useContentVisibility })
    if (!hasSelectionActions) return

    const range = selection.getRangeAt(0)
    const selectedMessageBodies = selectableMessageBodiesForRange(root, range)
    if (selectedMessageBodies.length !== 1) {
      publish({ textSelection: null })
      return
    }

    const body = selectedMessageBodies[0]
    const projection = readConversationSearchContent(body)
    let selectionStart: number | undefined
    let selectionEnd = 0
    for (const entry of projection.nodes) {
      const selected = selectedTextWithinElement(range, entry.node)
      if (!selected) continue
      const offset = range.startContainer === entry.node ? range.startOffset : 0
      selectionStart ??= entry.start + offset
      selectionEnd = entry.start + offset + selected.length
    }
    const selectedText = projection.text.slice(selectionStart ?? 0, selectionEnd)
    const text = selectedText.trim()
    const start = (selectionStart ?? 0) + selectedText.length - selectedText.trimStart().length
    if (!text) {
      publish({ textSelection: null })
      return
    }
    const rect = range.getBoundingClientRect()
    const nextSelection: MessageTextSelection = {
      text,
      messageId: body.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? '',
      content: projection.text,
      start,
      left: Math.min(Math.max(rect.left + rect.width / 2, 120), window.innerWidth - 120),
      top: Math.max(rect.top - SELECTION_ACTION_GAP, 44),
      conversationKey,
    }
    publish({ textSelection: nextSelection })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    attach(node: HTMLDivElement) {
      const binding = Symbol('message-selection-root')
      element = node
      lease = binding
      return () => {
        if (lease !== binding) return
        lease = null
        queueMicrotask(() => {
          if (lease !== null) return
          if (frame !== null) window.cancelAnimationFrame(frame)
          frame = null
          element = null
        })
      }
    },
    update,
    finalize(event: Event) {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="message-selection-actions"]')
      )
        return
      update(false, event.target)
    },
    schedule() {
      if (!attached() || frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        update(true)
      })
    },
    clearCapture() {
      publish({ textSelection: null })
    },
  }
}

function selectableMessageBodiesForRange(root: HTMLElement, range: Range): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-message-selectable-text]')).filter(
    element => selectedTextWithinElement(range, element).trim().length > 0
  )
}

function selectedTextWithinElement(range: Range, element: Node): string {
  if (!range.intersectsNode(element)) return ''

  const intersection = document.createRange()
  intersection.selectNodeContents(element)
  if (intersection.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
    intersection.setStart(range.startContainer, range.startOffset)
  }
  if (intersection.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
    intersection.setEnd(range.endContainer, range.endOffset)
  }
  return intersection.toString()
}

function isNodeInsideElement(node: Node | null, root: HTMLElement): boolean {
  if (!node) return false

  if (node.nodeType === Node.ELEMENT_NODE) {
    return root.contains(node)
  }

  return Boolean(node.parentElement && root.contains(node.parentElement))
}

function isEditableSelectionTarget(target?: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
      )
    )
  )
}
