import { useEffect, useRef } from 'react'
import { useEscapeKey } from '../markdown/useEscapeKey'
import { isolateModalBackground } from './dialogAccessibility'

const focusableSelector =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

function isFocusable(element: HTMLElement) {
  if (
    element.matches(':disabled') ||
    (element.tabIndex < 0 &&
      (!element.matches('[contenteditable="true"]') || element.hasAttribute('tabindex'))) ||
    element.closest('[hidden], [aria-hidden="true"], [inert]')
  )
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
  initialFocus?: string,
  trapFocus = true,
  restoreFocus?: string
) {
  const ref = useRef<T>(null)
  const opener = useRef<Element | null>(null)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current && typeof document !== 'undefined')
    opener.current = document.activeElement
  wasOpen.current = open
  useEscapeKey(onClose, open, ref)

  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const previousFocus = opener.current
    const focusContainer = dialog.closest('[role="dialog"]')
    if (!dialog.contains(document.activeElement)) {
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
    const restoreBackground = isolateModalBackground(dialog, trapFocus)
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const boundary = document.activeElement?.closest('[role="dialog"], dialog[open]')
      if (boundary && boundary !== dialog && !boundary.contains(dialog)) return
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
    if (trapFocus) dialog.addEventListener('keydown', handleTab)
    return () => {
      restoreBackground?.()
      dialog.removeEventListener('keydown', handleTab)
      const restoreOpener = () => {
        const returnTarget =
          previousFocus instanceof HTMLElement &&
          previousFocus !== document.body &&
          previousFocus.isConnected &&
          !previousFocus.closest('[hidden], [inert]')
            ? previousFocus
            : restoreFocus
              ? focusContainer?.querySelector<HTMLElement>(restoreFocus)
              : null
        if (
          returnTarget &&
          (dialog.contains(document.activeElement) ||
            document.activeElement === document.body ||
            (restoreFocus && focusContainer?.contains(document.activeElement)))
        )
          returnTarget.focus()
      }
      // Nested modal owners release inert during the same cleanup pass.
      if (previousFocus instanceof HTMLElement && previousFocus.closest('[inert]'))
        queueMicrotask(restoreOpener)
      else restoreOpener()
    }
  }, [open, initialFocus, trapFocus, restoreFocus])

  return ref
}
