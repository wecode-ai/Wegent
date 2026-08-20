export const WORKBENCH_NEW_CHAT_FOCUS_EVENT = 'wework:focus-new-chat-composer'
export const WORKBENCH_COMPOSER_FOCUS_EVENT = 'wework:focus-composer'

export interface WorkbenchComposerFocusDetail {
  scopeKey: string
}

let pendingWorkbenchComposerFocusScopeKey: string | null = null

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
  pendingWorkbenchComposerFocusScopeKey = scopeKey
  window.requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent<WorkbenchComposerFocusDetail>(WORKBENCH_COMPOSER_FOCUS_EVENT, {
        detail: { scopeKey },
      })
    )
  })
}

export function consumeWorkbenchComposerFocusRequest(scopeKey: string) {
  if (pendingWorkbenchComposerFocusScopeKey !== scopeKey) return false
  pendingWorkbenchComposerFocusScopeKey = null
  return true
}
