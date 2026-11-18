import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from 'react'
import { useDialogKeyboard } from './useDialogKeyboard'

const itemSelector = '[role="radio"]'

function availableItems(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(itemSelector)].filter(
    item =>
      item.getAttribute('aria-disabled') !== 'true' &&
      !item.closest('[inert], [hidden], [aria-hidden="true"]')
  )
}

function setTabStop(container: HTMLElement, item: HTMLElement | undefined) {
  for (const option of container.querySelectorAll<HTMLElement>(itemSelector))
    option.tabIndex = option === item ? 0 : -1
}

/** The picker owns modal focus; radio navigation never handles the reasoning form. */
export function useDesktopModelMenu(onClose: () => void, open: boolean) {
  const ref = useDialogKeyboard<HTMLDivElement>(onClose, open, '[role="radio"][tabindex="0"]')
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    const alreadyOpen = wasOpen.current
    wasOpen.current = open
    const dialog = ref.current
    if (!open || !dialog) return
    const items = availableItems(dialog)
    const active = document.activeElement
    const current = items.find(item => item === active)
    const selected = items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0]
    setTabStop(dialog, current ?? selected)
    // Initial focus belongs to useDialogKeyboard, which first captures the opener.
    if (!alreadyOpen) return
    if (
      dialog.contains(active) &&
      !(active instanceof Element && active.closest('[inert], [aria-hidden="true"]'))
    )
      return
    const target =
      selected ??
      [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled])'
        ),
      ].find(element => !element.closest('[inert], [aria-hidden="true"]'))
    target?.focus()
  })

  return {
    ref,
    onFocusCapture(event: FocusEvent<HTMLDivElement>) {
      if (!(event.target instanceof HTMLElement) || !event.target.matches(itemSelector)) return
      setTabStop(event.currentTarget, event.target)
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (
        !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) ||
        event.defaultPrevented ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.matches(itemSelector)) return
      const group = target.closest<HTMLElement>('[role="radiogroup"]')
      const items = group ? availableItems(group) : []
      const index = items.indexOf(target)
      if (index < 0) return
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + items.length) %
              items.length
      event.preventDefault()
      event.stopPropagation()
      setTabStop(group!, items[next])
      items[next]?.focus()
      items[next]?.click()
    },
  }
}
