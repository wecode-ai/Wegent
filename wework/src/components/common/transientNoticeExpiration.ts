const NOTICE_DURATION_MS = 2200

/** One notice owns its dismissal deadline; actionable notices remain until explicitly cleared. */
export function createTransientNoticeExpiration(
  message: string | null,
  onClear: () => void,
  interactive: boolean
) {
  const listeners = new Set<() => void>()
  let expired = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  return {
    getSnapshot: () => expired,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1 && message && !interactive && !expired) {
        timeout = setTimeout(() => {
          timeout = undefined
          expired = true
          listeners.forEach(notify => notify())
          onClear()
        }, NOTICE_DURATION_MS)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          clearTimeout(timeout)
          timeout = undefined
        }
      }
    },
  }
}
