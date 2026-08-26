export const WORKBENCH_NEW_CHAT_FOCUS_EVENT = 'wework:focus-new-chat-composer'
export const WORKBENCH_COMPOSER_FOCUS_EVENT = 'wework:focus-composer'

export interface WorkbenchComposerFocusDetail {
  scopeKey: string
}

interface PendingWorkbenchComposerFocus {
  scopeKey: string
  consumers: Set<symbol>
  expiresAt: number
}

const WORKBENCH_COMPOSER_FOCUS_TTL_MS = 2_000
const WORKBENCH_COMPOSER_FOCUS_CONSUMES = 2
let pendingWorkbenchComposerFocus: PendingWorkbenchComposerFocus | null = null

export function focusComposerAtEnd(element: HTMLElement | null | undefined) {
  if (!element) return
  element.focus()
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.setSelectionRange(element.value.length, element.value.length)
    return
  }
  if (!element.isContentEditable) return
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function requestNewChatComposerFocus() {
  window.requestAnimationFrame(() => {
    window.dispatchEvent(new Event(WORKBENCH_NEW_CHAT_FOCUS_EVENT))
  })
}

export function requestWorkbenchComposerFocus(scopeKey: string) {
  pendingWorkbenchComposerFocus = {
    scopeKey,
    consumers: new Set(),
    expiresAt: Date.now() + WORKBENCH_COMPOSER_FOCUS_TTL_MS,
  }
  window.requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent<WorkbenchComposerFocusDetail>(WORKBENCH_COMPOSER_FOCUS_EVENT, {
        detail: { scopeKey },
      })
    )
  })
}

export function consumeWorkbenchComposerFocusRequest(scopeKey: string, consumerId: symbol) {
  const pending = pendingWorkbenchComposerFocus
  if (!pending || pending.scopeKey !== scopeKey) return false
  if (pending.expiresAt < Date.now()) {
    pendingWorkbenchComposerFocus = null
    return false
  }
  if (pending.consumers.has(consumerId)) return false
  pending.consumers.add(consumerId)
  if (pending.consumers.size === WORKBENCH_COMPOSER_FOCUS_CONSUMES) {
    pendingWorkbenchComposerFocus = null
  }
  return true
}
