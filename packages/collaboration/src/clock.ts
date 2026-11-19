import { useMemo, useSyncExternalStore } from 'react'

const subscriptions = new Map<(now: number) => void, { resolution: number; nextAt: number }>()
let timer: ReturnType<typeof setTimeout> | undefined

function updateTimer() {
  clearTimeout(timer)
  timer = undefined
  if (!subscriptions.size) return
  const nextAt = Math.min(...Array.from(subscriptions.values(), entry => entry.nextAt))
  timer = setTimeout(tick, Math.max(1, Math.min(nextAt - Date.now(), 2_147_483_647)))
}

function publishTime(force = false) {
  const now = Date.now()
  subscriptions.forEach((entry, listener) => {
    if (!force && now < entry.nextAt) return
    entry.nextAt = now + entry.resolution
    listener(now)
  })
  updateTimer()
}
const tick = () => publishTime()
const refresh = () => publishTime(true)

function subscribeClock(listener: (now: number) => void, resolution: number) {
  subscriptions.set(listener, { resolution, nextAt: Date.now() + resolution })
  if (subscriptions.size === 1) {
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
  }
  updateTimer()
  return () => {
    if (!subscriptions.delete(listener)) return
    updateTimer()
    if (!subscriptions.size) {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }
}

function createClockReader(until: number | undefined, resolution: number, active: boolean) {
  let snapshot = Date.now()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      snapshot = Date.now()
      if (!active || (until !== undefined && snapshot >= until)) return () => {}
      const unsubscribe = subscribeClock(now => {
        snapshot = now
        listener()
        if (until !== undefined && now >= until) unsubscribe()
      }, resolution)
      return unsubscribe
    },
  }
}

export function useClock(
  active: boolean,
  { until, resolutionMs = 1000 }: { until?: number; resolutionMs?: number } = {}
): number {
  const reader = useMemo(
    () => createClockReader(until, resolutionMs, active),
    [until, resolutionMs, active]
  )
  return useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot)
}

/** Notify only on expiration, without rerendering the owner for countdown ticks. */
export function useDeadlineExpired(deadline: number | undefined): boolean {
  const store = useMemo(() => {
    const valid = deadline !== undefined && Number.isFinite(deadline)
    const getSnapshot = () => valid && Date.now() >= deadline
    return {
      getSnapshot,
      subscribe(listener: () => void) {
        if (!valid || getSnapshot()) return () => {}
        let timer: ReturnType<typeof setTimeout> | undefined
        const detach = () => {
          clearTimeout(timer)
          window.removeEventListener('focus', check)
          document.removeEventListener('visibilitychange', check)
        }
        const check = () => {
          clearTimeout(timer)
          if (getSnapshot()) {
            detach()
            listener()
          } else {
            timer = setTimeout(check, Math.min(deadline - Date.now(), 2_147_483_647))
          }
        }
        window.addEventListener('focus', check)
        document.addEventListener('visibilitychange', check)
        check()
        return detach
      },
    }
  }, [deadline])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => false)
}
