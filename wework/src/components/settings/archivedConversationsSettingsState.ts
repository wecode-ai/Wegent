export interface ArchivedBulkDeleteProgress {
  completed: number
  total: number
  running: boolean
}

type BulkDeleteProgressListener = (progress: ArchivedBulkDeleteProgress | null) => void
type BulkDeleteDeletedListener = (deletedKeys: Set<string>) => void

let archivedBulkDeleteProgress: ArchivedBulkDeleteProgress | null = null
const archivedCleanupListeners = new Set<(error: string | null) => void>()
const archivedCleanupFailedKeys = new Map<string, string>()
const archivedBulkDeletedKeys = new Set<string>()
const archivedBulkDeleteProgressListeners = new Set<BulkDeleteProgressListener>()
const archivedBulkDeleteDeletedListeners = new Set<BulkDeleteDeletedListener>()

export function beginArchivedCleanup(keys: string[]) {
  keys.forEach(key => archivedCleanupFailedKeys.delete(key))
  archivedCleanupListeners.forEach(listener => listener(getArchivedCleanupError()))
}

export function hasArchivedCleanupFailedKey(key: string) {
  return archivedCleanupFailedKeys.has(key)
}

export function getArchivedCleanupError() {
  return [...archivedCleanupFailedKeys.values()].join('\n') || null
}

export function reportArchivedCleanupFailure(key: string, error: string) {
  archivedCleanupFailedKeys.set(key, error)
  archivedBulkDeletedKeys.delete(key)
  archivedCleanupListeners.forEach(listener => listener(getArchivedCleanupError()))
}

export function subscribeArchivedCleanupError(listener: (error: string | null) => void) {
  archivedCleanupListeners.add(listener)
  return () => {
    archivedCleanupListeners.delete(listener)
  }
}

export function getArchivedBulkDeleteProgress() {
  return archivedBulkDeleteProgress
}

export function hasArchivedBulkDeletedKey(key: string) {
  return archivedBulkDeletedKeys.has(key)
}

export function setArchivedBulkDeleteProgress(progress: ArchivedBulkDeleteProgress | null) {
  archivedBulkDeleteProgress = progress
  archivedBulkDeleteProgressListeners.forEach(listener => listener(progress))
}

export function notifyArchivedBulkDeleteDeleted(deletedKeys: Set<string>) {
  const acceptedKeys = new Set([...deletedKeys].filter(key => !archivedCleanupFailedKeys.has(key)))
  acceptedKeys.forEach(key => archivedBulkDeletedKeys.add(key))
  archivedBulkDeleteDeletedListeners.forEach(listener => listener(acceptedKeys))
}

export function subscribeArchivedBulkDeleteProgress(listener: BulkDeleteProgressListener) {
  archivedBulkDeleteProgressListeners.add(listener)
  listener(archivedBulkDeleteProgress)
  return () => {
    archivedBulkDeleteProgressListeners.delete(listener)
  }
}

export function subscribeArchivedBulkDeleteDeleted(listener: BulkDeleteDeletedListener) {
  archivedBulkDeleteDeletedListeners.add(listener)
  return () => {
    archivedBulkDeleteDeletedListeners.delete(listener)
  }
}

export function resetArchivedConversationsSettingsStateForTest() {
  archivedCleanupListeners.clear()
  archivedCleanupFailedKeys.clear()
  archivedBulkDeleteProgress = null
  archivedBulkDeletedKeys.clear()
  archivedBulkDeleteProgressListeners.clear()
  archivedBulkDeleteDeletedListeners.clear()
}
