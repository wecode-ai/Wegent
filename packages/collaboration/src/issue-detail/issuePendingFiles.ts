import { useMemo, useSyncExternalStore, type SetStateAction } from 'react'
import type { SharedIssueDetailPort } from './createSharedIssueDetailPort'

const attachments = new WeakMap<SharedIssueDetailPort, Map<string, File[]>>()
function createPendingFiles(port: SharedIssueDetailPort, key: string | null) {
  let owner = attachments.get(port)
  if (!owner) {
    owner = new Map()
    attachments.set(port, owner)
  }
  let files = key ? (owner.get(key) ?? []) : []
  const listeners = new Set<() => void>()
  const ids = new WeakMap<File, string>()
  let nextId = 0
  return {
    getSnapshot: () => files,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setFiles(value: SetStateAction<File[]>) {
      files = typeof value === 'function' ? value(files) : value
      if (key) {
        if (files.length) owner.set(key, files)
        else owner.delete(key)
      }
      listeners.forEach(listener => listener())
    },
    fileId(file: File) {
      let id = ids.get(file)
      if (!id) {
        id = `pending-${nextId++}`
        ids.set(file, id)
      }
      return id
    },
    clearPersisted() {
      if (key) owner.delete(key)
    },
  }
}
export function useIssuePendingFiles(port: SharedIssueDetailPort, key: string | null) {
  const source = useMemo(() => createPendingFiles(port, key), [port, key])
  const files = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  return {
    files,
    setFiles: source.setFiles,
    fileId: source.fileId,
    clearPersisted: source.clearPersisted,
  }
}
