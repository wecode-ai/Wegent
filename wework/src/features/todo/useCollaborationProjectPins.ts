import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  commitLocalStorageValue,
  readCommittedLocalStorageValue,
} from '@/desktop/localStoragePersistence'

const changedEvent = 'wework:collaboration-project-pins-changed'
let pendingWrite = Promise.resolve()

function subscribe(listener: () => void) {
  window.addEventListener(changedEvent, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(changedEvent, listener)
    window.removeEventListener('storage', listener)
  }
}

function parsePins(snapshot: string | null): string[] {
  if (!snapshot) return []
  try {
    const parsed: unknown = JSON.parse(snapshot)
    return Array.isArray(parsed) ? parsed.filter(key => typeof key === 'string') : []
  } catch {
    return []
  }
}

export function useCollaborationProjectPins(accountScope: string) {
  const storageKey = `wework.collaboration.project-pins:${accountScope}`
  const read = useCallback(() => {
    try {
      return localStorage.getItem(storageKey)
    } catch {
      return null
    }
  }, [storageKey])
  const snapshot = useSyncExternalStore(subscribe, read, () => null)
  const keys = useMemo(() => parsePins(snapshot), [snapshot])
  const setPinned = (key: string, pinned: boolean) => {
    const write = pendingWrite.then(async () => {
      const stored = parsePins(await readCommittedLocalStorageValue(storageKey))
      const remaining = stored.filter(existing => existing !== key)
      const next = pinned ? [key, ...remaining] : remaining
      const snapshot = JSON.stringify(next)
      await commitLocalStorageValue(storageKey, snapshot)
      if (read() !== snapshot) {
        throw new Error('Could not publish committed collaboration project pins')
      }
      window.dispatchEvent(new Event(changedEvent))
    })
    pendingWrite = write.catch(() => {})
    return write
  }
  return { keys, setPinned }
}
