export type WorkbenchWindowActivity = 'foreground' | 'background' | 'hidden'

const listeners = new Set<(activity: WorkbenchWindowActivity) => void>()
let activity: WorkbenchWindowActivity = 'foreground'
let stopNative: (() => void) | undefined

export function subscribeWorkbenchWindowActivity(
  listener: (activity: WorkbenchWindowActivity) => void
): () => void {
  listeners.add(listener)
  const lifecycle = window.weworkElectronLifecycle
  if (!stopNative && lifecycle?.onWorkbenchActivityChanged) {
    let current = true
    let receivedEvent = false
    const publish = (next: unknown) => {
      if (!current || next === activity) return
      if (next !== 'foreground' && next !== 'background' && next !== 'hidden') return
      activity = next
      listeners.forEach(callback => callback(next))
    }
    const unsubscribe = lifecycle.onWorkbenchActivityChanged(next => {
      receivedEvent = true
      publish(next)
    })
    void lifecycle.getWorkbenchActivity?.().then(
      next => {
        if (!receivedEvent) publish(next)
      },
      error => console.error('[Wework] Failed to read workbench window activity:', error)
    )
    stopNative = () => {
      current = false
      unsubscribe()
    }
  }
  listener(activity)
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    stopNative?.()
    stopNative = undefined
    activity = 'foreground'
  }
}

/** Only use for refreshes whose results are consumed by the presenting window. */
export function pollWorkbenchPresentation(
  refresh: () => void,
  foregroundIntervalMs: number,
  backgroundIntervalMs: number
): () => void {
  let previous: WorkbenchWindowActivity | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const unsubscribe = subscribeWorkbenchWindowActivity(next => {
    clearInterval(timer)
    if (next !== 'hidden') {
      timer = setInterval(
        refresh,
        next === 'foreground' ? foregroundIntervalMs : backgroundIntervalMs
      )
    }
    const resumed = next === 'foreground' && previous !== undefined
    previous = next
    if (resumed) refresh()
  })
  return () => {
    unsubscribe()
    clearInterval(timer)
  }
}
