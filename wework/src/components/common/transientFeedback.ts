/** A visible feedback receipt owns one deadline while its surface is observed. */
export function createTransientFeedback(durationMs: number) {
  const listeners = new Set<() => void>()
  let active = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  return {
    getSnapshot: () => active,
    getServerSnapshot: () => false,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          clearTimeout(timeout)
          timeout = undefined
          active = false
        }
      }
    },
    show() {
      if (!listeners.size) return
      clearTimeout(timeout)
      active = true
      timeout = setTimeout(() => {
        timeout = undefined
        active = false
        listeners.forEach(listener => listener())
      }, durationMs)
      listeners.forEach(listener => listener())
    },
  }
}
