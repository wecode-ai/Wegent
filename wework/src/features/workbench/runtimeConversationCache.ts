import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import type { RuntimeTransportReplacedPayload } from '@/stream/chatStream'
import type { RuntimeGuidanceAppliedPayload, RuntimeTaskAddress } from '@/types/api'
import type {
  RuntimeConversationTurn,
  RuntimePaneQueuedMessage,
  WorkbenchMessage,
  ProcessingBlock,
} from '@/types/workbench'
import type { VirtualItem } from '@tanstack/react-virtual'
import {
  appendRuntimeConversationGuidance,
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
} from './runtimeConversationTurns'
import { createAppliedRuntimeGuidanceMessage } from './runtimeGuidanceMessages'

const MAX_CONVERSATION_CACHE_ENTRIES = 50
const turnsByConversation = new Map<string, RuntimeConversationTurn[]>()
const listenersByConversation = new Map<string, Set<(action?: RuntimePaneMessageAction) => void>>()
const runtimeTransportReplacedListeners = new Set<
  (payload: RuntimeTransportReplacedPayload) => void
>()
const hydrationByConversation = new Map<
  string,
  {
    token: symbol
    bufferedActions: RuntimePaneMessageAction[]
  }
>()
const queuedMessagesByConversation = new Map<string, RuntimePaneQueuedMessage[]>()
const queuedMessagesPausedByConversation = new Map<string, boolean>()
const interruptedGuidanceIdsByConversation = new Map<string, Set<string>>()
const scrollSnapshotsByConversation = new Map<string, ConversationScrollSnapshot>()
const virtualMeasurementsByConversation = new Map<string, VirtualItem[]>()

export interface ConversationScrollSnapshot {
  distanceFromBottomPx: number
  pinnedToBottom: boolean
}

export function getRuntimeConversationMessages(address: RuntimeTaskAddress): WorkbenchMessage[] {
  const key = runtimeConversationKey(address)
  return projectRuntimeConversationTurns(touchEntry(turnsByConversation, key) ?? [])
}

export function subscribeRuntimeConversation(
  address: RuntimeTaskAddress,
  listener: (action?: RuntimePaneMessageAction) => void
): () => void {
  const key = runtimeConversationKey(address)
  const listeners = listenersByConversation.get(key) ?? new Set()
  listeners.add(listener)
  listenersByConversation.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) listenersByConversation.delete(key)
  }
}

export function publishRuntimeTransportReplaced(payload: RuntimeTransportReplacedPayload): void {
  runtimeTransportReplacedListeners.forEach(listener => listener(payload))
}

export function subscribeRuntimeTransportReplaced(
  listener: (payload: RuntimeTransportReplacedPayload) => void
): () => void {
  runtimeTransportReplacedListeners.add(listener)
  return () => runtimeTransportReplacedListeners.delete(listener)
}

export function beginRuntimeConversationHydration(address: RuntimeTaskAddress): symbol {
  const key = runtimeConversationKey(address)
  const existing = hydrationByConversation.get(key)
  if (existing) return existing.token
  const token = Symbol(key)
  hydrationByConversation.set(key, { token, bufferedActions: [] })
  return token
}

export function completeRuntimeConversationHydration(
  address: RuntimeTaskAddress,
  token: symbol,
  snapshotTurns: RuntimeConversationTurn[]
): WorkbenchMessage[] {
  const key = runtimeConversationKey(address)
  const hydration = hydrationByConversation.get(key)
  if (hydration?.token !== token) return getRuntimeConversationMessages(address)

  let turns = mergeRuntimeConversationTurns(turnsByConversation.get(key) ?? [], snapshotTurns)
  for (const action of hydration.bufferedActions) {
    turns = reduceRuntimeConversationTurns(turns, action)
  }
  hydrationByConversation.delete(key)
  cacheBoundedEntry(turnsByConversation, key, turns)
  notifyHydratedRuntimeConversation(key, hydration.bufferedActions)
  return projectRuntimeConversationTurns(turns)
}

export function abortRuntimeConversationHydration(
  address: RuntimeTaskAddress,
  token: symbol
): WorkbenchMessage[] {
  const key = runtimeConversationKey(address)
  const hydration = hydrationByConversation.get(key)
  if (hydration?.token !== token) return getRuntimeConversationMessages(address)

  let turns = turnsByConversation.get(key) ?? []
  for (const action of hydration.bufferedActions) {
    turns = reduceRuntimeConversationTurns(turns, action)
  }
  hydrationByConversation.delete(key)
  cacheBoundedEntry(turnsByConversation, key, turns)
  notifyHydratedRuntimeConversation(key, hydration.bufferedActions)
  return projectRuntimeConversationTurns(turns)
}

export function reconcileRuntimeConversationSnapshot(
  address: RuntimeTaskAddress,
  snapshotTurns: RuntimeConversationTurn[]
): WorkbenchMessage[] {
  const key = runtimeConversationKey(address)
  const localTurns = turnsByConversation.get(key) ?? []
  const turns = mergeRuntimeConversationTurns(localTurns, snapshotTurns)
  cacheBoundedEntry(turnsByConversation, key, turns)
  notifyRuntimeConversation(key)
  return projectRuntimeConversationTurns(turns)
}

export function runtimeConversationSnapshotSettlesLatestTurn(
  address: RuntimeTaskAddress,
  snapshotTurns: RuntimeConversationTurn[]
): boolean {
  const localTurns = turnsByConversation.get(runtimeConversationKey(address)) ?? []
  const latestLocalTurn = localTurns.at(-1)
  if (!latestLocalTurn) return true

  const snapshotTurn =
    latestLocalTurn.id !== null
      ? snapshotTurns.find(turn => turn.id === latestLocalTurn.id)
      : snapshotTurns.find(turn =>
          turnContainsClientUserMessage(turn, latestLocalTurn.clientUserMessageId)
        )
  return snapshotTurn ? !isUnsettledTurn(snapshotTurn) : false
}

export function applyRuntimeConversationAction(
  address: RuntimeTaskAddress,
  action: RuntimePaneMessageAction
): WorkbenchMessage[] {
  const key = runtimeConversationKey(address)
  const hydration = hydrationByConversation.get(key)
  if (hydration) {
    hydration.bufferedActions.push(action)
    return projectRuntimeConversationTurns(turnsByConversation.get(key) ?? [])
  }
  const currentTurns = turnsByConversation.get(key) ?? []
  const nextTurns = reduceRuntimeConversationTurns(currentTurns, action)
  cacheBoundedEntry(turnsByConversation, key, nextTurns)
  notifyRuntimeConversation(key, action)
  return projectRuntimeConversationTurns(nextTurns)
}

export function updateRuntimeConversationBlocks(
  address: RuntimeTaskAddress,
  update: (block: ProcessingBlock) => ProcessingBlock
): WorkbenchMessage[] {
  return updateRuntimeConversationTurns(address, turns =>
    turns.map(turn => ({
      ...turn,
      items: turn.items.map(item =>
        item.type === 'block' ? { ...item, block: update(item.block) } : item
      ),
    }))
  )
}

export function removeRuntimeConversationTurn(
  address: RuntimeTaskAddress,
  identity: { turnId?: string; clientUserMessageId?: string }
): WorkbenchMessage[] {
  return updateRuntimeConversationTurns(address, turns =>
    turns.filter(turn => {
      if (identity.turnId && turn.id === identity.turnId) return false
      if (
        identity.clientUserMessageId &&
        (turn.clientUserMessageId === identity.clientUserMessageId ||
          turn.items.some(
            item => item.type === 'user_message' && item.id === identity.clientUserMessageId
          ))
      ) {
        return false
      }
      return true
    })
  )
}

export function replaceRuntimeConversationFromUserMessage(
  address: RuntimeTaskAddress,
  sourceClientUserMessageId: string,
  replacement: WorkbenchMessage & { role: 'user' }
): WorkbenchMessage[] {
  return updateRuntimeConversationTurns(address, turns => {
    const sourceTurnIndex = turns.findIndex(turn =>
      turn.items.some(item => item.type === 'user_message' && item.id === sourceClientUserMessageId)
    )
    if (sourceTurnIndex < 0) return turns
    const retainedTurns = turns.slice(0, sourceTurnIndex)
    return reduceRuntimeConversationTurns(retainedTurns, {
      type: 'user_added',
      message: replacement,
    })
  })
}

function updateRuntimeConversationTurns(
  address: RuntimeTaskAddress,
  update: (turns: RuntimeConversationTurn[]) => RuntimeConversationTurn[]
): WorkbenchMessage[] {
  const key = runtimeConversationKey(address)
  const currentTurns = turnsByConversation.get(key) ?? []
  const nextTurns = update(currentTurns)
  cacheBoundedEntry(turnsByConversation, key, nextTurns)
  notifyRuntimeConversation(key)
  return projectRuntimeConversationTurns(nextTurns)
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
  const key = runtimeConversationKey(address)
  const turns = turnsByConversation.get(key)
  if (!turns) return null

  const guidanceMessage = takeAppliedRuntimeConversationGuidance(address, payload)
  if (!guidanceMessage) return null

  if (takeInterruptedRuntimeConversationGuidance(address, guidanceMessage.id)) {
    notifyRuntimeConversation(key)
    return guidanceMessage
  }

  if (turns.some(turn => turnContainsClientUserMessage(turn, guidanceMessage.id))) {
    notifyRuntimeConversation(key)
    return guidanceMessage
  }

  const appliedGuidance = createAppliedRuntimeGuidanceMessage(guidanceMessage, payload)
  const nextTurns = appendRuntimeConversationGuidance(turns, payload.subtaskId, appliedGuidance)
  cacheBoundedEntry(turnsByConversation, key, nextTurns)
  notifyRuntimeConversation(key)
  return guidanceMessage
}

export function markRuntimeConversationGuidanceInterrupted(
  address: RuntimeTaskAddress,
  clientGuidanceIds: Iterable<string>
): void {
  const key = runtimeConversationKey(address)
  const ids = interruptedGuidanceIdsByConversation.get(key) ?? new Set<string>()
  for (const id of clientGuidanceIds) ids.add(id)
  if (ids.size > 0) interruptedGuidanceIdsByConversation.set(key, ids)
}

export function takeInterruptedRuntimeConversationGuidance(
  address: RuntimeTaskAddress,
  clientGuidanceId: string
): boolean {
  const key = runtimeConversationKey(address)
  const ids = interruptedGuidanceIdsByConversation.get(key)
  if (!ids?.delete(clientGuidanceId)) return false
  if (ids.size === 0) interruptedGuidanceIdsByConversation.delete(key)
  return true
}

export function clearInterruptedRuntimeConversationGuidanceExcept(
  address: RuntimeTaskAddress,
  retainedClientGuidanceId: string
): void {
  const key = runtimeConversationKey(address)
  const ids = interruptedGuidanceIdsByConversation.get(key)
  if (!ids) return
  for (const id of ids) {
    if (id !== retainedClientGuidanceId) ids.delete(id)
  }
  if (ids.size === 0) interruptedGuidanceIdsByConversation.delete(key)
}

function findAppliedGuidanceMessage(
  messages: RuntimePaneQueuedMessage[],
  payload: RuntimeGuidanceAppliedPayload
): RuntimePaneQueuedMessage | undefined {
  const clientGuidanceId = payload.clientGuidanceId
  if (!clientGuidanceId) return undefined
  return messages.find(message => message.id === clientGuidanceId)
}

function turnContainsClientUserMessage(
  turn: RuntimeConversationTurn,
  clientUserMessageId: string | undefined
): boolean {
  if (!clientUserMessageId) return false
  return (
    turn.clientUserMessageId === clientUserMessageId ||
    turn.items.some(item => item.type === 'user_message' && item.id === clientUserMessageId)
  )
}

function isUnsettledTurn(turn: RuntimeConversationTurn): boolean {
  return turn.status === 'pending' || turn.status === 'streaming'
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
  turnsByConversation.delete(key)
  hydrationByConversation.delete(key)
  queuedMessagesByConversation.delete(key)
  queuedMessagesPausedByConversation.delete(key)
  scrollSnapshotsByConversation.delete(key)
  virtualMeasurementsByConversation.delete(key)
}

export function getRuntimeConversationCacheStats() {
  return {
    messageEntries: turnsByConversation.size,
    scrollSnapshotEntries: scrollSnapshotsByConversation.size,
    virtualMeasurementEntries: virtualMeasurementsByConversation.size,
  }
}

export function clearRuntimeConversationCacheForTests() {
  turnsByConversation.clear()
  listenersByConversation.clear()
  runtimeTransportReplacedListeners.clear()
  hydrationByConversation.clear()
  queuedMessagesByConversation.clear()
  queuedMessagesPausedByConversation.clear()
  interruptedGuidanceIdsByConversation.clear()
  scrollSnapshotsByConversation.clear()
  virtualMeasurementsByConversation.clear()
}

function notifyRuntimeConversation(key: string, action?: RuntimePaneMessageAction) {
  listenersByConversation.get(key)?.forEach(listener => listener(action))
}

function notifyHydratedRuntimeConversation(
  key: string,
  bufferedActions: RuntimePaneMessageAction[]
): void {
  if (bufferedActions.length === 0) {
    notifyRuntimeConversation(key)
    return
  }
  bufferedActions.forEach(action => notifyRuntimeConversation(key, action))
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
