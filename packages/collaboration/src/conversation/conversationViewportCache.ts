import type { VirtualItem } from "@tanstack/react-virtual";

const MAX_CONVERSATION_CACHE_ENTRIES = 50;
const scrollSnapshotsByConversation = new Map<
  string,
  ConversationScrollSnapshot
>();
const virtualMeasurementsByConversation = new Map<string, VirtualItem[]>();

export interface ConversationScrollSnapshot {
  distanceFromBottomPx: number;
  pinnedToBottom: boolean;
}

export function getConversationScrollSnapshot(
  key: string,
): ConversationScrollSnapshot | undefined {
  return touchEntry(scrollSnapshotsByConversation, key);
}

export function hasConversationScrollSnapshot(key: string): boolean {
  return scrollSnapshotsByConversation.has(key);
}

export function cacheConversationScrollSnapshot(
  key: string,
  snapshot: ConversationScrollSnapshot,
) {
  cacheBoundedEntry(scrollSnapshotsByConversation, key, snapshot);
}

export function getConversationVirtualMeasurements(
  key: string,
): VirtualItem[] | undefined {
  return touchEntry(virtualMeasurementsByConversation, key);
}

export function cacheConversationVirtualMeasurements(
  key: string,
  measurements: VirtualItem[],
) {
  virtualMeasurementsByConversation.delete(key);
  if (measurements.length > 0) {
    cacheBoundedEntry(virtualMeasurementsByConversation, key, measurements);
  }
}

export function evictConversationViewport(key: string) {
  scrollSnapshotsByConversation.delete(key);
  virtualMeasurementsByConversation.delete(key);
}

export function clearConversationViewportCache() {
  scrollSnapshotsByConversation.clear();
  virtualMeasurementsByConversation.clear();
}

export function getConversationViewportCacheStats() {
  return {
    scrollSnapshotEntries: scrollSnapshotsByConversation.size,
    virtualMeasurementEntries: virtualMeasurementsByConversation.size,
  };
}

function touchEntry<T>(entries: Map<string, T>, key: string): T | undefined {
  const value = entries.get(key);
  if (value === undefined) return undefined;
  entries.delete(key);
  entries.set(key, value);
  return value;
}

function cacheBoundedEntry<T>(
  entries: Map<string, T>,
  key: string,
  value: T,
  onEvict?: (key: string) => void,
) {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > MAX_CONVERSATION_CACHE_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) return;
    onEvict?.(oldestKey);
    entries.delete(oldestKey);
  }
}
