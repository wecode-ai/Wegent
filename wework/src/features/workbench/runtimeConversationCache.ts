import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import type { Attachment, RuntimeTaskAddress, TurnFileChangesSummary } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import type { VirtualItem } from '@tanstack/react-virtual'
import { reduceWorkbenchMessages } from '@wegent/chat-core'

const MAX_CONVERSATION_CACHE_ENTRIES = 50
const messagesByConversation = new Map<string, WorkbenchMessage[]>()
const scrollSnapshotsByConversation = new Map<string, ConversationScrollSnapshot>()
const virtualMeasurementsByConversation = new Map<string, VirtualItem[]>()

export interface ConversationScrollSnapshot {
  distanceFromBottomPx: number
  pinnedToBottom: boolean
}

export function getRuntimeConversationMessages(address: RuntimeTaskAddress): WorkbenchMessage[] {
  return touchEntry(messagesByConversation, runtimeConversationKey(address)) ?? []
}

export function cacheRuntimeConversationMessages(
  address: RuntimeTaskAddress,
  messages: WorkbenchMessage[]
) {
  cacheBoundedEntry(messagesByConversation, runtimeConversationKey(address), messages)
}

export function applyRuntimeConversationAction(
  address: RuntimeTaskAddress,
  action: RuntimePaneMessageAction
) {
  const key = runtimeConversationKey(address)
  const currentMessages = messagesByConversation.get(key) ?? []
  cacheBoundedEntry(
    messagesByConversation,
    key,
    reduceWorkbenchMessages<Attachment, TurnFileChangesSummary>(currentMessages, action)
  )
}

export function runtimeConversationKey(address: RuntimeTaskAddress): string {
  return runtimeConversationViewKey(address)
}

export function runtimeConversationViewKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.taskId}`
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

export function getConversationVirtualMeasurements(key: string): VirtualItem[] | undefined {
  return touchEntry(virtualMeasurementsByConversation, key)
}

export function cacheConversationVirtualMeasurements(key: string, measurements: VirtualItem[]) {
  virtualMeasurementsByConversation.delete(key)
  if (measurements.length > 0) {
    cacheBoundedEntry(virtualMeasurementsByConversation, key, measurements)
  }
}

export function evictRuntimeConversation(address: RuntimeTaskAddress) {
  messagesByConversation.delete(runtimeConversationKey(address))
  const viewKey = runtimeConversationViewKey(address)
  scrollSnapshotsByConversation.delete(viewKey)
  virtualMeasurementsByConversation.delete(viewKey)
}

export function getRuntimeConversationCacheStats() {
  return {
    messageEntries: messagesByConversation.size,
    scrollSnapshotEntries: scrollSnapshotsByConversation.size,
    virtualMeasurementEntries: virtualMeasurementsByConversation.size,
  }
}

export function clearRuntimeConversationCacheForTests() {
  messagesByConversation.clear()
  scrollSnapshotsByConversation.clear()
  virtualMeasurementsByConversation.clear()
}

function touchEntry<T>(entries: Map<string, T>, key: string): T | undefined {
  const value = entries.get(key)
  if (value === undefined) return undefined
  entries.delete(key)
  entries.set(key, value)
  return value
}

function cacheBoundedEntry<T>(entries: Map<string, T>, key: string, value: T) {
  entries.delete(key)
  entries.set(key, value)
  while (entries.size > MAX_CONVERSATION_CACHE_ENTRIES) {
    const oldestKey = entries.keys().next().value
    if (oldestKey === undefined) return
    entries.delete(oldestKey)
  }
}
