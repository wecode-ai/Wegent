export interface HoverCardObserver {
  interactive: boolean
  controlledPinned?: boolean
  onPinnedChange?: (pinned: boolean) => void
  onOpenChange?: (open: boolean) => void
}

/** Own hover visibility, focus retention, pin requests and their cancellable delays. */
export function createHoverCardState() {
  const observers = new Set<HoverCardObserver & { notify(): void }>()
  let snapshot = { open: false, uncontrolledPinned: false }
  let focusWithin = false
  let pinned = false
  let committedPinned: boolean | undefined
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let reported: { callback: HoverCardObserver['onOpenChange']; open: boolean } | undefined
  const owner = () => [...observers].at(-1)
  const report = () => {
    const current = owner()
    if (!current) return
    const open = snapshot.open || (current.controlledPinned ?? snapshot.uncontrolledPinned)
    if (reported && reported.callback === current.onOpenChange && reported.open === open) return
    reported = { callback: current.onOpenChange, open }
    current.onOpenChange?.(open)
  }
  const publish = (next: typeof snapshot) => {
    if (!observers.size) return
    if (next.open !== snapshot.open || next.uncontrolledPinned !== snapshot.uncontrolledPinned) {
      snapshot = next
      for (const observer of observers) observer.notify()
    }
    report()
  }
  const clearTimers = () => {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
    openTimer = closeTimer = undefined
  }
  const updatePinned = (value: boolean) => {
    pinned = value
    const current = owner()
    const uncontrolledPinned =
      current?.controlledPinned === undefined ? value : snapshot.uncontrolledPinned
    current?.onPinnedChange?.(value)
    return uncontrolledPinned
  }
  const close = () => {
    if (!observers.size) return
    clearTimers()
    focusWithin = false
    publish({ open: false, uncontrolledPinned: updatePinned(false) })
  }
  const show = () => {
    clearTimers()
    publish({ ...snapshot, open: true })
  }
  const keepOpen = () => {
    clearTimeout(closeTimer)
    closeTimer = undefined
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void, metadata: HoverCardObserver) {
      const observer = { notify, ...metadata }
      observers.add(observer)
      const nextPinned = metadata.controlledPinned ?? snapshot.uncontrolledPinned
      if (nextPinned !== committedPinned) {
        committedPinned = nextPinned
        pinned = nextPinned
      }
      report()
      return () => {
        observers.delete(observer)
        queueMicrotask(() => {
          if (!observers.size) clearTimers()
        })
      }
    },
    show,
    close,
    keepOpen,
    pin() {
      if (!observers.size) return
      keepOpen()
      publish({ ...snapshot, uncontrolledPinned: updatePinned(true) })
    },
    setFocusWithin(value: boolean) {
      focusWithin = value
    },
    hasFocus: () => focusWithin,
    isPinned: () => pinned,
    scheduleOpen() {
      clearTimers()
      openTimer = setTimeout(show, 450)
    },
    scheduleClose() {
      if (pinned || focusWithin) return
      if (!owner()?.interactive) return close()
      clearTimeout(openTimer)
      openTimer = undefined
      closeTimer ??= setTimeout(close, 120)
    },
  }
}
