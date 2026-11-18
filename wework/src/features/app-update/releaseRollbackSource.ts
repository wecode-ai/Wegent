import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { flushDesktopLocalStoragePersistence } from '@/desktop/localStoragePersistence'
import { isElectronRuntime } from '@/lib/runtime-environment'

type PreviousRelease = { version: string; restoreRequired: boolean } | null
interface RollbackSnapshot {
  previous: PreviousRelease
  open: boolean
  busy: boolean
  error: 'load' | 'rollback' | null
}

/** Metadata reads and progress belong to the settings surface; confirmation admits rollback. */
export function createReleaseRollbackSource() {
  let snapshot: RollbackSnapshot = { previous: null, open: false, busy: false, error: null }
  const listeners = new Set<() => void>()
  let generation = 0
  let observation = 0
  let operation = 0
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  const publish = (patch: Partial<RollbackSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  function schedulePoll() {
    clearTimeout(pollTimer)
    if (!listeners.size || !snapshot.busy) return
    const epoch = generation
    const attempt = operation
    pollTimer = setTimeout(async () => {
      try {
        const progress = await invokeDesktopHost<{ phase?: string }>('appUpdate.downloadProgress')
        if (epoch !== generation || attempt !== operation || !listeners.size || !snapshot.busy)
          return
        if (progress?.phase === 'failed') publish({ error: 'rollback', busy: false })
      } catch {
        // Progress observation does not replace the rollback command's own result.
      } finally {
        if (epoch === generation && attempt === operation) schedulePoll()
      }
    }, 250)
  }
  function readPrevious() {
    if (!isElectronRuntime()) return
    const epoch = generation
    void invokeDesktopHost<PreviousRelease>('appUpdate.previousRelease')
      .then(value => {
        if (epoch === generation && listeners.size) publish({ previous: value })
      })
      .catch(() => {
        if (epoch === generation && listeners.size) publish({ error: 'load' })
      })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      const revision = ++observation
      listeners.add(listener)
      if (listeners.size === 1) {
        generation += 1
        readPrevious()
        schedulePoll()
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size || revision !== observation) return
          generation += 1
          clearTimeout(pollTimer)
        })
      }
    },
    open() {
      publish({ open: true })
    },
    close() {
      publish({ open: false })
    },
    async confirm() {
      if (!snapshot.open || snapshot.busy || !listeners.size) return
      const restoreConfirmed = snapshot.previous?.restoreRequired === true
      const attempt = ++operation
      publish({ open: false, busy: true, error: null })
      schedulePoll()
      try {
        await flushDesktopLocalStoragePersistence()
        await invokeDesktopHost('appUpdate.rollback', { restoreConfirmed })
      } catch {
        if (attempt !== operation) return
        clearTimeout(pollTimer)
        publish({ error: 'rollback', busy: false })
      }
    },
  }
}
