/** Cancellation receipts and accessible feedback belong to the actual status widget. */
export function createConnectionEventStatusSource() {
  let snapshot = {
    cancelled: [] as string[],
    announcement: '',
    pending: [] as string[],
    unsupportedFailure: false,
    errors: {} as Record<string, boolean>,
  }
  const listeners = new Set<() => void>()
  const inFlight = new Set<string>()
  let node: HTMLDivElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let binding: object | undefined
  function armAnnouncement() {
    clearTimeout(timer)
    if (!listeners.size || !snapshot.announcement) return
    timer = setTimeout(() => {
      if (!node?.contains(document.activeElement)) publish({ announcement: '' })
    }, 5000)
  }
  function publish(patch: Partial<typeof snapshot>) {
    const announcementChanged =
      patch.announcement !== undefined && patch.announcement !== snapshot.announcement
    snapshot = { ...snapshot, ...patch }
    if (announcementChanged) armAnnouncement()
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      armAnnouncement()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) clearTimeout(timer)
      }
    },
    bindContainer(container: HTMLDivElement | null) {
      if (!container) return
      const owner = {}
      binding = owner
      node = container
      return () => {
        if (binding === owner) {
          node = undefined
          binding = undefined
        }
      }
    },
    clearAnnouncement: () => publish({ announcement: '' }),
    async cancel(key: string, text: string, onCancel: (key: string) => Promise<void>) {
      if (inFlight.has(key)) return
      const focused = document.activeElement
      const restoreFocus = node?.contains(focused)
      inFlight.add(key)
      publish({ pending: [...snapshot.pending, key], errors: { ...snapshot.errors, [key]: false } })
      try {
        await onCancel(key)
        publish({ cancelled: [...snapshot.cancelled, key], announcement: text })
        requestAnimationFrame(() => {
          if (
            restoreFocus &&
            (document.activeElement === focused || document.activeElement === document.body)
          ) {
            const target = node?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? node
            target?.focus()
          }
        })
      } catch (failure) {
        const code =
          failure && typeof failure === 'object' && 'code' in failure ? failure.code : null
        if (code === 'unsupported_method' || code === 'connection_event_upgrade_required')
          publish({ unsupportedFailure: true })
        else publish({ errors: { ...snapshot.errors, [key]: true } })
      } finally {
        inFlight.delete(key)
        publish({ pending: snapshot.pending.filter(value => value !== key) })
      }
    },
  }
}
