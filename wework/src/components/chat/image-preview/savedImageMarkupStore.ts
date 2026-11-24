import { useSyncExternalStore } from 'react'
import type { SavedImageMarkup } from './ImageEditContext'

/** Edited image bytes stay in memory only for previews the user can still reach. */
const MAX_SAVED_IMAGES = 8
const savedImages = new Map<number, SavedImageMarkup>()
/** Maps an attachment produced by a save back to the draft that produced it. */
const sourceKeys = new Map<number, number>()
const listeners = new Set<() => void>()

function sourceKey(attachmentId: number) {
  let key = attachmentId
  for (let depth = 0; depth < MAX_SAVED_IMAGES; depth += 1) {
    const parent = sourceKeys.get(key)
    if (parent === undefined || parent === key) break
    key = parent
  }
  return key
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Share the latest saved markup across previews that started from the same draft. */
export function publishSavedImageMarkup(attachmentId: number, saved: SavedImageMarkup) {
  const key = sourceKey(attachmentId)
  if (saved.attachmentId !== key) sourceKeys.set(saved.attachmentId, key)
  savedImages.delete(key)
  savedImages.set(key, saved)
  while (savedImages.size > MAX_SAVED_IMAGES) {
    const oldest = savedImages.keys().next().value
    if (oldest === undefined) break
    savedImages.delete(oldest)
  }
  for (const [from, to] of sourceKeys) {
    if (!savedImages.has(to)) sourceKeys.delete(from)
  }
  while (sourceKeys.size > MAX_SAVED_IMAGES) {
    const oldest = sourceKeys.keys().next().value
    if (oldest === undefined) break
    sourceKeys.delete(oldest)
  }
  for (const listener of listeners) listener()
}

export function useSavedImageMarkup(attachmentId?: number): SavedImageMarkup | null {
  return useSyncExternalStore(
    subscribe,
    () => (attachmentId === undefined ? null : (savedImages.get(sourceKey(attachmentId)) ?? null)),
    () => null
  )
}
