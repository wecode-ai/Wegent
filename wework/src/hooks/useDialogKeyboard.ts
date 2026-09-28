import { useEffect, useRef } from 'react'
import { useEscapeKey } from './useEscapeKey'

const focusableSelector =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function isFocusable(element: HTMLElement) {
  if (element.tabIndex < 0 || element.closest('[hidden], [aria-hidden="true"], [inert]'))
    return false
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

export function useDialogKeyboard<T extends HTMLElement>(
  onClose: () => void,
  open = true,
  initialFocus?: string
) {
  const ref = useRef<T>(null)
  useEscapeKey(onClose, open, ref)

  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const previousFocus = document.activeElement
    if (!dialog.contains(previousFocus)) {
      const preferred = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          initialFocus ??
            'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), button[type="submit"]:not([disabled])'
        )
      ).find(isFocusable)
      const target =
        preferred ??
        Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).find(isFocusable) ??
        dialog
      target.focus()
    }
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const elements = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        isFocusable
      )
      const first = elements[0]
      const last = elements.at(-1)
      if (!first) {
        event.preventDefault()
        dialog.focus()
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    dialog.addEventListener('keydown', handleTab)
    return () => {
      dialog.removeEventListener('keydown', handleTab)
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        (dialog.contains(document.activeElement) || document.activeElement === document.body)
      )
        previousFocus.focus()
    }
  }, [open, initialFocus])

  return ref
}
