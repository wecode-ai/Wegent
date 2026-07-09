export interface ArchivedBulkDeleteProgress {
  completed: number
  total: number
  running: boolean
}

type BulkDeleteProgressListener = (progress: ArchivedBulkDeleteProgress | null) => void
type BulkDeleteDeletedListener = (deletedKeys: Set<string>) => void

let archivedBulkDeleteProgress: ArchivedBulkDeleteProgress | null = null
const archivedBulkDeletedKeys = new Set<string>()
const archivedBulkDeleteProgressListeners = new Set<BulkDeleteProgressListener>()
const archivedBulkDeleteDeletedListeners = new Set<BulkDeleteDeletedListener>()

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
  deletedKeys.forEach(key => archivedBulkDeletedKeys.add(key))
  archivedBulkDeleteDeletedListeners.forEach(listener => listener(deletedKeys))
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
  archivedBulkDeleteProgress = null
  archivedBulkDeletedKeys.clear()
  archivedBulkDeleteProgressListeners.clear()
  archivedBulkDeleteDeletedListeners.clear()
}
