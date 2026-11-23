const SHOW_DELAY_MS = 700

interface TooltipTarget {
  button: HTMLButtonElement
  label: string
}

interface TooltipSnapshot {
  target: TooltipTarget | null
  visible: boolean
}

const buttonFromTarget = (target: EventTarget | null) =>
  target instanceof Element ? target.closest<HTMLButtonElement>('button[aria-label]') : null

/** Own a fallback tooltip's delayed visibility, with native events registered by its UI host. */
export function createIconButtonTooltipController() {
  const listeners = new Set<() => void>()
  let snapshot: TooltipSnapshot = { target: null, visible: false }
  let timer: ReturnType<typeof setTimeout> | null = null
  let hoveredTrigger: Element | null = null
  const publish = (next: TooltipSnapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const hide = () => {
    clearTimer()
    if (snapshot.target || snapshot.visible) publish({ target: null, visible: false })
  }
  const schedule = (button: HTMLButtonElement, eventTarget: EventTarget | null) => {
    const label = button.getAttribute('aria-label')?.trim()
    if (
      !label ||
      button.closest('[data-tooltip-trigger]') ||
      (hoveredTrigger && button.contains(hoveredTrigger)) ||
      (eventTarget instanceof Element && eventTarget.closest('[data-tooltip-trigger]'))
    ) {
      hide()
      return
    }
    clearTimer()
    const target = { button, label }
    publish({ target, visible: false })
    timer = setTimeout(() => {
      timer = null
      if (button.isConnected) publish({ target, visible: true })
      else hide()
    }, SHOW_DELAY_MS)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          hoveredTrigger = null
          hide()
        }
      }
    },
    hide,
    pointerOver(event: PointerEvent) {
      hoveredTrigger =
        event.target instanceof Element ? event.target.closest('[data-tooltip-trigger]') : null
      const button = buttonFromTarget(event.target)
      if (button) schedule(button, event.target)
      else hide()
    },
    pointerOut(event: PointerEvent) {
      if (
        hoveredTrigger &&
        (!(event.relatedTarget instanceof Node) || !hoveredTrigger.contains(event.relatedTarget))
      )
        hoveredTrigger = null
      const button = buttonFromTarget(event.target)
      if (button && !(event.relatedTarget instanceof Node && button.contains(event.relatedTarget)))
        hide()
    },
    focusIn(event: FocusEvent) {
      const button = buttonFromTarget(event.target)
      if (button) schedule(button, event.target)
    },
    focusOut(event: FocusEvent) {
      const button = buttonFromTarget(event.target)
      if (button && !(event.relatedTarget instanceof Node && button.contains(event.relatedTarget)))
        hide()
    },
    keyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') hide()
    },
  }
}
