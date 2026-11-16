import { useRef } from 'react'

/** Reuse a panel's existing discard confirmation for explicit navigation. */
export function useStandInPanelNavigation(
  dirty: boolean,
  busy: boolean,
  requestDiscard: () => void
) {
  const pending = useRef<(() => void) | null>(null)
  return {
    requestLeave(action: () => void) {
      if (busy) return
      if (!dirty) {
        action()
        return
      }
      pending.current = action
      requestDiscard()
    },
    confirmLeave(fallback: () => void) {
      const action = pending.current ?? fallback
      pending.current = null
      action()
    },
    cancelLeave() {
      pending.current = null
    },
  }
}
