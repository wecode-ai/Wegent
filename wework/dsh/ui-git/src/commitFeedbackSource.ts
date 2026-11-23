/** The visible Git panel owns commit feedback and accepted-operation receipts. */
export function createCommitFeedbackSource() {
  let snapshot = {
    status: 'idle' as 'idle' | 'committing' | 'success',
    progress: '',
    error: null as string | null,
  }
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const clearTimer = () => clearTimeout(timer)
  const publish = (patch: Partial<typeof snapshot>) => {
    if (!listeners.size) return
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          revision += 1
          clearTimer()
        })
      }
    },
    clearTimer,
    captureOwner() {
      const owner = ++revision
      return () => listeners.size > 0 && revision === owner
    },
    setStatus: (status: typeof snapshot.status) => publish({ status }),
    setProgress: (progress: string) => publish({ progress }),
    setError: (error: string | null) => publish({ error }),
    scheduleReset() {
      clearTimer()
      const owner = revision
      timer = setTimeout(() => {
        if (revision === owner) publish({ status: 'idle', progress: '' })
      }, 1600)
    },
  }
}
