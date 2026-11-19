/** Clipboard acceptance and its temporary acknowledgement belong to the visible badge. */
export function createDevInstanceClipboard() {
  let copiedKey: string | null = null
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const publish = (key: string | null) => {
    copiedKey = key
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => copiedKey,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          revision += 1
          clearTimeout(timer)
        }
      }
    },
    async copy(key: string, value: string) {
      const current = ++revision
      await navigator.clipboard?.writeText(value)
      if (!listeners.size || current !== revision) return
      publish(key)
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (listeners.size && current === revision) publish(null)
      }, 1200)
    },
  }
}
