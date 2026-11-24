export interface IssueBoardCardPreviewInputs {
  itemId: string
  available: boolean
  pinned?: boolean
  unread: boolean
  onPinnedChange?(open: boolean): void
  onMarkRead?(): void
}

/** Preview openness owns its read dwell; callback replacement never restarts reading time. */
export function createIssueBoardCardPreview() {
  let open = false
  let localOpen = false
  let inputs: IssueBoardCardPreviewInputs | undefined
  let invalidPinReported = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let readingItem: string | undefined
  let readAttempted = false
  const listeners = new Set<() => void>()
  const stopReading = () => {
    clearTimeout(timer)
    timer = undefined
    readingItem = undefined
    readAttempted = false
  }
  const updateReading = () => {
    if (!inputs || !open || !inputs.unread || !inputs.onMarkRead) {
      stopReading()
      return
    }
    if (readingItem !== inputs.itemId) {
      stopReading()
      readingItem = inputs.itemId
    }
    if (timer !== undefined || readAttempted || !listeners.size) return
    timer = setTimeout(() => {
      timer = undefined
      if (!listeners.size || !inputs || !open || !inputs.unread || !inputs.onMarkRead) return
      readAttempted = true
      inputs.onMarkRead()
    }, 3000)
  }
  const update = () => {
    const next = Boolean(inputs?.available && (inputs.pinned ?? localOpen))
    if (next !== open) {
      open = next
      listeners.forEach(listener => listener())
    }
    updateReading()
  }
  return {
    getSnapshot: () => open,
    setOpen(next: boolean) {
      localOpen = next
      inputs?.onPinnedChange?.(next)
      update()
    },
    subscribe(listener: () => void, nextInputs: IssueBoardCardPreviewInputs) {
      let attached = true
      const notify = () => {
        if (attached) listener()
      }
      listeners.add(notify)
      inputs = nextInputs
      if (!inputs.available) {
        localOpen = false
        if (inputs.pinned && !invalidPinReported) {
          invalidPinReported = true
          inputs.onPinnedChange?.(false)
        }
      }
      if (inputs.available || !inputs.pinned) invalidPinReported = false
      update()
      return () => {
        attached = false
        listeners.delete(notify)
        queueMicrotask(() => {
          if (!listeners.size) stopReading()
        })
      }
    },
  }
}
