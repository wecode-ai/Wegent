const RUNTIME_ARCHIVE_UNDO_DELAY_MS = 3000

interface PendingRuntimeTaskArchive {
  token: object
  noticeOpen: boolean
  runArchive: () => void
  timerId: number
}

const pendingRuntimeTaskArchives = new Map<string, PendingRuntimeTaskArchive>()
const pendingRuntimeTaskArchiveListeners = new Map<string, Set<() => void>>()

function notifyPendingRuntimeTaskArchive(key: string) {
  pendingRuntimeTaskArchiveListeners.get(key)?.forEach(listener => listener())
}

export function subscribePendingRuntimeTaskArchive(
  key: string,
  listener: () => void,
  runArchive: () => void
) {
  const pending = pendingRuntimeTaskArchives.get(key)
  if (pending) pending.runArchive = runArchive
  const listeners = pendingRuntimeTaskArchiveListeners.get(key) ?? new Set<() => void>()
  listeners.add(listener)
  pendingRuntimeTaskArchiveListeners.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      pendingRuntimeTaskArchiveListeners.delete(key)
    }
  }
}

export function getPendingRuntimeTaskArchive(key: string) {
  return pendingRuntimeTaskArchives.get(key) ?? null
}

export function schedulePendingRuntimeTaskArchive(key: string, runArchive: () => void) {
  const existing = pendingRuntimeTaskArchives.get(key)
  if (existing) {
    window.clearTimeout(existing.timerId)
  }
  const token = {}
  const pending: PendingRuntimeTaskArchive = {
    token,
    noticeOpen: true,
    runArchive,
    timerId: window.setTimeout(() => {
      const current = pendingRuntimeTaskArchives.get(key)
      if (!current || current.token !== token) return
      pendingRuntimeTaskArchives.delete(key)
      notifyPendingRuntimeTaskArchive(key)
      current.runArchive()
    }, RUNTIME_ARCHIVE_UNDO_DELAY_MS),
  }
  pendingRuntimeTaskArchives.set(key, pending)
  notifyPendingRuntimeTaskArchive(key)
}

export function undoPendingRuntimeTaskArchive(key: string) {
  const pending = pendingRuntimeTaskArchives.get(key)
  if (!pending) return
  window.clearTimeout(pending.timerId)
  pendingRuntimeTaskArchives.delete(key)
  notifyPendingRuntimeTaskArchive(key)
}

export function dismissPendingRuntimeTaskArchiveNotice(key: string) {
  const pending = pendingRuntimeTaskArchives.get(key)
  if (!pending || !pending.noticeOpen) return
  pendingRuntimeTaskArchives.set(key, { ...pending, noticeOpen: false })
  notifyPendingRuntimeTaskArchive(key)
}
