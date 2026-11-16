import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { useDialogKeyboard } from './useDialogKeyboard'

/** Own focus inside the portaled picker independently of its hosting dialog. */
export function useModelSelectorKeyboard(onClose: () => void, open: boolean) {
  const ref = useDialogKeyboard<HTMLDivElement>(onClose, open)
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    const alreadyOpen = wasOpen.current
    wasOpen.current = open
    const dialog = ref.current
    if (!open || !dialog) return
    const radios = [...dialog.querySelectorAll<HTMLElement>('[role="radio"]')]
    const checked = radios.find(radio => radio.getAttribute('aria-checked') === 'true')
    for (const radio of radios) radio.tabIndex = radio === (checked ?? radios[0]) ? 0 : -1
    if (!alreadyOpen) return
    const active = document.activeElement
    if (
      dialog.contains(active) &&
      !(active instanceof Element && active.closest('[inert], [aria-hidden="true"]'))
    )
      return
    const target = [
      ...dialog.querySelectorAll<HTMLElement>(
        '[role="radio"][tabindex="0"], button:not([disabled]):not([tabindex="-1"]), input:not([disabled])'
      ),
    ].find(element => !element.closest('[inert], [aria-hidden="true"]'))
    target?.focus()
  })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
      return
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return
    const target = event.target
    if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'radio') return
    const group = target.closest('[role="radiogroup"]')
    const radios = [...(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])].filter(
      radio => radio.getAttribute('aria-disabled') !== 'true'
    )
    const index = radios.indexOf(target)
    if (index < 0) return
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? radios.length - 1
          : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + radios.length) %
            radios.length
    event.preventDefault()
    radios[next]?.focus()
    radios[next]?.click()
  }
  return { ref, onKeyDown }
}
