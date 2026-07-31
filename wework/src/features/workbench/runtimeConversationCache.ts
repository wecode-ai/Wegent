import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import type {
  Attachment,
  RuntimeGuidanceAppliedPayload,
  RuntimeTaskAddress,
  TurnFileChangesSummary,
} from '@/types/api'
import type { RuntimePaneQueuedMessage, WorkbenchMessage } from '@/types/workbench'
import type { VirtualItem } from '@tanstack/react-virtual'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import {
  createAppliedRuntimeGuidanceMessage,
  insertAppliedRuntimeGuidance,
  transformRuntimePaneActionForGuidanceSplits,
  type GuidanceSplitBoundaries,
} from './runtimeGuidanceMessages'

const MAX_CONVERSATION_CACHE_ENTRIES = 50
const messagesByConversation = new Map<string, WorkbenchMessage[]>()
const queuedMessagesByConversation = new Map<string, RuntimePaneQueuedMessage[]>()
const queuedMessagesPausedByConversation = new Map<string, boolean>()
const scrollSnapshotsByConversation = new Map<string, ConversationScrollSnapshot>()
const virtualMeasurementsByConversation = new Map<string, VirtualItem[]>()
const guidanceSplitBoundariesByConversation = new Map<string, GuidanceSplitBoundaries>()

export type RuntimeConversationQueueEvent = {
  type: 'guidance_applied'
  payload: RuntimeGuidanceAppliedPayload
}

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
  const splitBoundaries = touchEntry(guidanceSplitBoundariesByConversation, key)
  const actionForReduction = splitBoundaries
    ? transformRuntimePaneActionForGuidanceSplits(action, splitBoundaries)
    : action
  cacheBoundedEntry(
    messagesByConversation,
    key,
    reduceWorkbenchMessages<Attachment, TurnFileChangesSummary>(currentMessages, actionForReduction)
  )
}

export function getRuntimeConversationQueuedMessages(
  address: RuntimeTaskAddress
): RuntimePaneQueuedMessage[] {
  return getRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(address))
}

export function getRuntimeConversationQueuedMessagesByKey(key: string): RuntimePaneQueuedMessage[] {
  return touchEntry(queuedMessagesByConversation, key) ?? []
}

export function cacheRuntimeConversationQueuedMessages(
  address: RuntimeTaskAddress,
  messages: RuntimePaneQueuedMessage[]
) {
  cacheRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(address), messages)
}

export function cacheRuntimeConversationQueuedMessagesByKey(
  key: string,
  messages: RuntimePaneQueuedMessage[]
) {
  if (messages.length === 0) {
    queuedMessagesByConversation.delete(key)
    return
  }
  cacheBoundedEntry(queuedMessagesByConversation, key, messages)
}

export function dispatchRuntimeConversationQueueEvent(
  address: RuntimeTaskAddress,
  event: RuntimeConversationQueueEvent
) {
  const key = runtimeConversationKey(address)
  const messages = queuedMessagesByConversation.get(key)
  if (!messages) return

  const nextMessages = reduceRuntimeConversationQueue(messages, event)
  if (nextMessages.length === messages.length) return
  cacheRuntimeConversationQueuedMessagesByKey(key, nextMessages)
}

export function takeAppliedRuntimeConversationGuidance(
  address: RuntimeTaskAddress,
  payload: RuntimeGuidanceAppliedPayload
): RuntimePaneQueuedMessage | null {
  const key = runtimeConversationKey(address)
  const queuedMessages = queuedMessagesByConversation.get(key)
  if (!queuedMessages) return null

  const guidanceMessage = findAppliedGuidanceMessage(queuedMessages, payload)
  if (!guidanceMessage) return null

  cacheRuntimeConversationQueuedMessagesByKey(
    key,
    queuedMessages.filter(message => message.id !== guidanceMessage.id)
  )
  return guidanceMessage
}

export function settleRuntimeConversationGuidance(
  address: RuntimeTaskAddress,
  payload: RuntimeGuidanceAppliedPayload
): RuntimePaneQueuedMessage | null {
  const guidanceMessage = takeAppliedRuntimeConversationGuidance(address, payload)
  if (!guidanceMessage) return null

  const key = runtimeConversationKey(address)
  const messages = messagesByConversation.get(key) ?? []
  if (messages.some(message => message.id === guidanceMessage.id)) return guidanceMessage

  const appliedGuidance = createAppliedRuntimeGuidanceMessage(guidanceMessage, payload)
  cacheBoundedEntry(
    messagesByConversation,
    key,
    insertAppliedRuntimeGuidance(
      messages,
      appliedGuidance,
      getRuntimeConversationGuidanceSplitBoundaries(address)
    )
  )
  return guidanceMessage
}

export function getRuntimeConversationGuidanceSplitBoundaries(
  address: RuntimeTaskAddress
): GuidanceSplitBoundaries {
  const key = runtimeConversationKey(address)
  const existing = touchEntry(guidanceSplitBoundariesByConversation, key)
  if (existing) return existing
  const boundaries: GuidanceSplitBoundaries = new Map()
  cacheBoundedEntry(guidanceSplitBoundariesByConversation, key, boundaries)
  return boundaries
}

export function reduceRuntimeConversationQueue(
  messages: RuntimePaneQueuedMessage[],
  event: RuntimeConversationQueueEvent
): RuntimePaneQueuedMessage[] {
  switch (event.type) {
    case 'guidance_applied':
      return messages.filter(message => {
        if (message.id === event.payload.guidanceId) return false
        return !(
          message.status === 'sending' &&
          message.deliveryMode === 'guidance' &&
          Boolean(event.payload.message) &&
          message.content === event.payload.message
        )
      })
  }
}

function findAppliedGuidanceMessage(
  messages: RuntimePaneQueuedMessage[],
  payload: RuntimeGuidanceAppliedPayload
): RuntimePaneQueuedMessage | undefined {
  return messages.find(message => {
    if (message.id === payload.guidanceId) return true
    return (
      message.status === 'sending' &&
      message.deliveryMode === 'guidance' &&
      Boolean(payload.message) &&
      message.content === payload.message
    )
  })
}

export function getRuntimeConversationQueuePaused(address: RuntimeTaskAddress): boolean {
  return getRuntimeConversationQueuePausedByKey(runtimeConversationKey(address))
}

export function getRuntimeConversationQueuePausedByKey(key: string): boolean {
  return touchEntry(queuedMessagesPausedByConversation, key) ?? false
}

export function cacheRuntimeConversationQueuePaused(address: RuntimeTaskAddress, paused: boolean) {
  cacheRuntimeConversationQueuePausedByKey(runtimeConversationKey(address), paused)
}

export function cacheRuntimeConversationQueuePausedByKey(key: string, paused: boolean) {
  if (!paused) {
    queuedMessagesPausedByConversation.delete(key)
    return
  }
  cacheBoundedEntry(queuedMessagesPausedByConversation, key, true)
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
  const key = runtimeConversationKey(address)
  messagesByConversation.delete(key)
  queuedMessagesByConversation.delete(key)
  queuedMessagesPausedByConversation.delete(key)
  guidanceSplitBoundariesByConversation.delete(key)
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
  queuedMessagesByConversation.clear()
  queuedMessagesPausedByConversation.clear()
  scrollSnapshotsByConversation.clear()
  virtualMeasurementsByConversation.clear()
  guidanceSplitBoundariesByConversation.clear()
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
