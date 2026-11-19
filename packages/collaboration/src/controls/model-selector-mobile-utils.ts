import type { KeyboardEvent } from 'react'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export function handleMobileModelSelectorDialogKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  menuElement: HTMLDivElement | null,
  onClose: () => void
) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    onClose()
    return
  }
  if (event.key !== 'Tab' || !menuElement) return

  const focusableElements = Array.from(
    menuElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter(element => element.offsetParent !== null)
  if (focusableElements.length === 0) return

  const firstElement = focusableElements[0]
  const lastElement = focusableElements[focusableElements.length - 1]
  if (event.shiftKey && document.activeElement === firstElement) {
    event.preventDefault()
    lastElement.focus()
  } else if (!event.shiftKey && document.activeElement === lastElement) {
    event.preventDefault()
    firstElement.focus()
  }
}
