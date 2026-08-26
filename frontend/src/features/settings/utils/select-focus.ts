export function preventSelectCloseFromStealingFocus(
  event: Event,
  activeElement: Element | null,
  triggerElement: HTMLElement | null,
  contentElement: HTMLElement | null
): void {
  if (
    !(activeElement instanceof HTMLElement) ||
    activeElement === document.body ||
    activeElement === triggerElement ||
    contentElement?.contains(activeElement)
  ) {
    return
  }

  event.preventDefault()
}
