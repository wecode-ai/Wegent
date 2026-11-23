/** Native editor widgets may provide richer focus behavior than HTMLElement.focus. */
export interface EditorFocusTarget {
  readonly element: HTMLElement | null
  focus(): void
}

export interface EditorFocusGuard {
  /** Match the nearest owner, so an inactive child cannot inherit an active ancestor. */
  activeScope?: { selector: string; matches: string }
  guardModalFocus?: boolean
  onlyFromBodyOrTarget?: boolean
}

/** Apply an eligible editor focus command without taking ownership from another control. */
export function focusEditorTarget(
  target: EditorFocusTarget | null,
  { activeScope, guardModalFocus = false, onlyFromBodyOrTarget = false }: EditorFocusGuard = {}
): boolean {
  const node = target?.element
  if (!target || !node?.isConnected || node.closest('[hidden], [aria-hidden="true"], [inert]'))
    return false
  if (activeScope && !node.closest(activeScope.selector)?.matches(activeScope.matches)) return false
  const active = document.activeElement
  if (
    onlyFromBodyOrTarget &&
    active &&
    active !== document.body &&
    active !== document.documentElement &&
    active !== node
  )
    return false
  if (
    guardModalFocus &&
    Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).some(
      dialog => !dialog.contains(node) && !dialog.closest('[hidden], [aria-hidden="true"], [inert]')
    )
  )
    return false
  target.focus()
  return true
}
