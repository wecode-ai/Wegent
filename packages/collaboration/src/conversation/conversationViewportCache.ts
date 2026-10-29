import type { VirtualItem } from '@tanstack/react-virtual'

const MAX_CONVERSATION_CACHE_ENTRIES = 50
const scrollSnapshotsByConversation = new Map<string, ConversationScrollSnapshot>()
const virtualMeasurementsByConversation = new Map<string, VirtualItem[]>()
const virtualLayoutsByConversation = new Map<string, VirtualMeasurementLayout>()

export interface VirtualMeasurementLayout {
  key: string
  messages: ReadonlyMap<string, string>
}

export interface ConversationScrollSnapshot {
  distanceFromBottomPx: number
  pinnedToBottom: boolean
  anchor?: {
    messageId: string
    itemId: string | null
    textOffset: number | null
    offsetFromScrollerTop: number
  }
}

export function getConversationScrollSnapshot(key: string): ConversationScrollSnapshot | undefined {
  return touchEntry(scrollSnapshotsByConversation, key)
}

export function hasConversationScrollSnapshot(key: string): boolean {
  return scrollSnapshotsByConversation.has(key)
}

export function cacheConversationScrollSnapshot(key: string, snapshot: ConversationScrollSnapshot) {
  cacheBoundedEntry(scrollSnapshotsByConversation, key, snapshot)
}

export function getConversationVirtualMeasurements(
  key: string,
  layout?: VirtualMeasurementLayout
): VirtualItem[] | undefined {
  const measurements = touchEntry(virtualMeasurementsByConversation, key)
  if (!layout) return measurements
  const previous = virtualLayoutsByConversation.get(key)
  if (!previous || previous.key !== layout.key) return undefined
  // Never restore expansion/edit/search geometry as the default collapsed row.
  return measurements?.filter(
    item =>
      typeof item.key === 'string' &&
      layout.messages.has(item.key) &&
      previous.messages.get(item.key) === layout.messages.get(item.key)
  )
}

export function cacheConversationVirtualMeasurements(
  key: string,
  measurements: VirtualItem[],
  layout?: VirtualMeasurementLayout
) {
  virtualMeasurementsByConversation.delete(key)
  virtualLayoutsByConversation.delete(key)
  if (measurements.length > 0) {
    if (layout) virtualLayoutsByConversation.set(key, layout)
    cacheBoundedEntry(virtualMeasurementsByConversation, key, measurements, evictedKey =>
      virtualLayoutsByConversation.delete(evictedKey)
    )
  }
}

export function evictConversationViewport(key: string) {
  scrollSnapshotsByConversation.delete(key)
  virtualMeasurementsByConversation.delete(key)
  virtualLayoutsByConversation.delete(key)
}

export function migrateConversationViewport(previousKey: string, nextKey: string) {
  const scroll = getConversationScrollSnapshot(previousKey)
  if (scroll && !getConversationScrollSnapshot(nextKey)) {
    cacheConversationScrollSnapshot(nextKey, scroll)
  }
  const measurements = getConversationVirtualMeasurements(previousKey)
  if (measurements && !getConversationVirtualMeasurements(nextKey)) {
    cacheConversationVirtualMeasurements(
      nextKey,
      measurements,
      virtualLayoutsByConversation.get(previousKey)
    )
  }
  evictConversationViewport(previousKey)
}

export function clearConversationViewportCache() {
  scrollSnapshotsByConversation.clear()
  virtualMeasurementsByConversation.clear()
  virtualLayoutsByConversation.clear()
}

export function getConversationViewportCacheStats() {
  return {
    scrollSnapshotEntries: scrollSnapshotsByConversation.size,
    virtualMeasurementEntries: virtualMeasurementsByConversation.size,
  }
}

function touchEntry<T>(entries: Map<string, T>, key: string): T | undefined {
  const value = entries.get(key)
  if (value === undefined) return undefined
  entries.delete(key)
  entries.set(key, value)
  return value
}

function cacheBoundedEntry<T>(
  entries: Map<string, T>,
  key: string,
  value: T,
  onEvict?: (key: string) => void
) {
  entries.delete(key)
  entries.set(key, value)
  while (entries.size > MAX_CONVERSATION_CACHE_ENTRIES) {
    const oldestKey = entries.keys().next().value
    if (oldestKey === undefined) return
    onEvict?.(oldestKey)
    entries.delete(oldestKey)
  }
}
