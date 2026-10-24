import { useEffect, useState } from 'react'

/** Recompute the pending overlay once its deadline passes, even without a runtime event. */
export function useRequestUserInputExpiryRefresh(deadline: number | undefined) {
  const [, refresh] = useState(0)

  useEffect(() => {
    if (deadline === undefined || !Number.isFinite(deadline)) return
    let timer: number | undefined
    let expired = false
    const checkDeadline = () => {
      if (expired) return
      window.clearTimeout(timer)
      const remaining = deadline - Date.now()
      if (remaining > 0) {
        timer = window.setTimeout(checkDeadline, Math.min(remaining, 2_147_483_647))
      } else {
        expired = true
        refresh(value => value + 1)
      }
    }
    checkDeadline()
    window.addEventListener('focus', checkDeadline)
    document.addEventListener('visibilitychange', checkDeadline)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', checkDeadline)
      document.removeEventListener('visibilitychange', checkDeadline)
    }
  }, [deadline])
}
