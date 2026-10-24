import {
  cacheConversationScrollSnapshot,
  cacheConversationVirtualMeasurements,
  clearConversationViewportCache,
  evictConversationViewport,
  getConversationScrollSnapshot,
  getConversationVirtualMeasurements,
  getConversationViewportCacheStats,
} from '@wegent/collaboration/conversation/conversationViewportCache'
import { getUnambiguousWorkbenchDeviceAliases } from '@/lib/workbench-device'
import type {
  DeviceInfo,
  RuntimeGoal,
  RuntimeGoalContinuationPayload,
  RuntimePlanEventPayload,
  RuntimeTaskAddress,
} from '@/types/api'
import type {
  RuntimeConversationTurn,
  RuntimePaneQueuedMessage,
  RuntimeSubagentStatus,
  WorkbenchMessage,
} from '@/types/workbench'
import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import { mergeRuntimeConversationTurns } from './runtimeConversationTurns'

const MAX_CONVERSATION_CACHE_ENTRIES = 50
export const MAX_RUNTIME_SUBAGENT_STATUSES = 256
const TERMINAL_CONVERSATION_IDLE_TTL_MS = 5 * 60 * 1000
type Listener = (action?: RuntimePaneMessageAction) => void
interface Subscription {
  key: string
  listener: Listener
}

export interface RuntimeConversationMetadata {
  goal: RuntimeGoal | null
  goalContinuation: RuntimeGoalContinuationPayload | null
  taskPlan: RuntimePlanEventPayload | null
  subagentStatuses: RuntimeSubagentStatus[]
}

export const turnsByConversation = new Map<string, RuntimeConversationTurn[]>()
export const threadIdsByConversation = new Map<string, string>()
export const supersededTurnIdsByConversation = new Map<string, Set<string>>()
export const projectedMessagesByConversation = new Map<
  string,
  { turns: RuntimeConversationTurn[]; messages: WorkbenchMessage[] }
>()
export const metadataByConversation = new Map<string, RuntimeConversationMetadata>()
const listenersByConversation = new Map<string, Set<Subscription>>()
const retainingListenersByConversation = new Map<string, Set<Subscription>>()
export const hydrationByConversation = new Map<
  string,
  { token: symbol; bufferedActions: RuntimePaneMessageAction[] }
>()
export const queuedMessagesByConversation = new Map<string, RuntimePaneQueuedMessage[]>()
export const queuedMessagesPausedByConversation = new Map<string, boolean>()
export const interruptedGuidanceIdsByConversation = new Map<string, Set<string>>()
export const pendingStreamingNotifications = new Map<string, () => void>()
const terminalConversationEvictionTimers = new Map<
  string,
  ReturnType<typeof globalThis.setTimeout>
>()
export const goalSnapshotVersionsByConversation = new Map<string, number>()
const canonicalDeviceIdByAlias = new Map<string, string>()
let revisionByValue = new WeakMap<object, number>()
let nextRevision = 1

export function runtimeConversationKey(address: RuntimeTaskAddress): string {
  return `${canonicalRuntimeConversationDeviceId(address.deviceId)}:${address.taskId}`
}

export function syncRuntimeConversationDeviceAliases(devices: DeviceInfo[]): void {
  let changed = false
  for (const [alias, canonical] of getUnambiguousWorkbenchDeviceAliases(devices)) {
    if (canonicalDeviceIdByAlias.get(alias) === canonical) continue
    canonicalDeviceIdByAlias.set(alias, canonical)
    changed = true
  }
  if (!changed) return

  const aliases = [...canonicalDeviceIdByAlias.keys()].sort((a, b) => b.length - a.length)
  const keys = new Set(conversationMaps().flatMap(entries => [...entries.keys()]))
  const migratedKeys = new Set<string>()
  for (const key of keys) {
    const alias = aliases.find(candidate => key.startsWith(`${candidate}:`))
    if (!alias) continue
    const nextKey = runtimeConversationKey({ deviceId: alias, taskId: key.slice(alias.length + 1) })
    if (nextKey === key) continue
    migrateRuntimeConversation(key, nextKey)
    migratedKeys.add(nextKey)
  }
  for (const key of migratedKeys) {
    scheduleTerminalConversationEviction(key)
    notifyRuntimeConversation(key)
  }
}

function canonicalRuntimeConversationDeviceId(deviceId: string): string {
  let current = deviceId.trim()
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const canonical = canonicalDeviceIdByAlias.get(current)
    if (!canonical || canonical === current) break
    current = canonical
  }
  return current
}

function conversationMaps(): Map<string, unknown>[] {
  return [
    turnsByConversation,
    threadIdsByConversation,
    supersededTurnIdsByConversation,
    projectedMessagesByConversation,
    metadataByConversation,
    listenersByConversation,
    retainingListenersByConversation,
    hydrationByConversation,
    queuedMessagesByConversation,
    queuedMessagesPausedByConversation,
    interruptedGuidanceIdsByConversation,
    pendingStreamingNotifications,
    terminalConversationEvictionTimers,
    goalSnapshotVersionsByConversation,
  ]
}

function migrateRuntimeConversation(previousKey: string, nextKey: string): void {
  cancelPendingStreamingNotification(previousKey)
  cancelTerminalConversationEviction(previousKey)
  cancelTerminalConversationEviction(nextKey)
  const previousThread = threadIdsByConversation.get(previousKey)
  const currentThread = threadIdsByConversation.get(nextKey)
  const replacedThread = Boolean(
    previousThread && currentThread && previousThread !== currentThread
  )
  if (replacedThread) {
    turnsByConversation.delete(previousKey)
    hydrationByConversation.delete(previousKey)
    supersededTurnIdsByConversation.delete(previousKey)
    evictConversationViewport(previousKey)
  }
  moveEntry(threadIdsByConversation, previousKey, nextKey, (_, current) => current)
  moveEntry(
    supersededTurnIdsByConversation,
    previousKey,
    nextKey,
    (previous, current) => new Set([...previous, ...current])
  )
  moveEntry(turnsByConversation, previousKey, nextKey, (previous, current) =>
    isMoreRecent(previous, current)
      ? mergeRuntimeConversationTurns(current, previous)
      : mergeRuntimeConversationTurns(previous, current)
  )
  projectedMessagesByConversation.delete(previousKey)
  projectedMessagesByConversation.delete(nextKey)
  moveEntry(metadataByConversation, previousKey, nextKey, (previous, current) =>
    mergeMetadata(
      previous,
      current,
      (goalSnapshotVersionsByConversation.get(previousKey) ?? 0) >
        (goalSnapshotVersionsByConversation.get(nextKey) ?? 0)
    )
  )
  for (const subscription of listenersByConversation.get(previousKey) ?? []) {
    subscription.key = nextKey
  }
  moveEntry(listenersByConversation, previousKey, nextKey, mergeSets)
  moveEntry(retainingListenersByConversation, previousKey, nextKey, mergeSets)
  moveEntry(hydrationByConversation, previousKey, nextKey, (previous, current) => ({
    token: current.token,
    bufferedActions: [...previous.bufferedActions, ...current.bufferedActions],
  }))
  moveEntry(queuedMessagesByConversation, previousKey, nextKey, (previous, current) => {
    const messages = isMoreRecent(previous, current)
      ? [...current, ...previous]
      : [...previous, ...current]
    return [...new Map(messages.map(message => [message.id, message])).values()].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt)
    )
  })
  moveEntry(queuedMessagesPausedByConversation, previousKey, nextKey, (_, current) => current)
  moveEntry(interruptedGuidanceIdsByConversation, previousKey, nextKey, mergeSets)
  moveEntry(goalSnapshotVersionsByConversation, previousKey, nextKey, Math.max)
  reconcileAcceptedQueuedMessages(nextKey, turnsByConversation.get(nextKey) ?? [])
  const scroll = getConversationScrollSnapshot(previousKey)
  if (scroll && !getConversationScrollSnapshot(nextKey)) {
    cacheConversationScrollSnapshot(nextKey, scroll)
  }
  const measurements = getConversationVirtualMeasurements(previousKey)
  if (measurements && !getConversationVirtualMeasurements(nextKey)) {
    cacheConversationVirtualMeasurements(nextKey, measurements)
  }
  evictConversationViewport(previousKey)
}

function moveEntry<T>(
  entries: Map<string, T>,
  previousKey: string,
  nextKey: string,
  merge: (previous: T, current: T) => T
): void {
  const previous = entries.get(previousKey)
  if (previous === undefined) return
  const current = entries.get(nextKey)
  const next = current === undefined ? previous : merge(previous, current)
  if (typeof next === 'object' && next !== null) {
    revisionByValue.set(next, Math.max(valueRevision(previous), valueRevision(current)))
  }
  entries.set(nextKey, next)
  entries.delete(previousKey)
}

function valueRevision(value: unknown): number {
  return typeof value === 'object' && value !== null ? (revisionByValue.get(value) ?? 0) : 0
}

function isMoreRecent(previous: unknown, current: unknown): boolean {
  return valueRevision(previous) > valueRevision(current)
}

function mergeSets<T>(previous: Set<T>, current: Set<T>): Set<T> {
  return new Set([...previous, ...current])
}

function mergeMetadata(
  previous: RuntimeConversationMetadata,
  current: RuntimeConversationMetadata,
  previousGoalIsNewer: boolean
): RuntimeConversationMetadata {
  const statuses = new Map(current.subagentStatuses.map(status => [status.id, status]))
  for (const status of previous.subagentStatuses) {
    const existing = statuses.get(status.id)
    if (!existing || (status.updatedAtMs ?? 0) > (existing.updatedAtMs ?? 0)) {
      statuses.set(status.id, status)
    }
  }
  return {
    goal:
      previous.goal && current.goal
        ? previous.goal.updatedAt > current.goal.updatedAt
          ? previous.goal
          : current.goal
        : previousGoalIsNewer
          ? previous.goal
          : current.goal,
    goalContinuation: current.goalContinuation ?? previous.goalContinuation,
    taskPlan: current.taskPlan ?? previous.taskPlan,
    subagentStatuses: [...statuses.values()]
      .sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0))
      .slice(0, MAX_RUNTIME_SUBAGENT_STATUSES),
  }
}

export function subscribeRuntimeConversation(
  address: RuntimeTaskAddress,
  listener: Listener,
  options?: { retainWhileSubscribed?: boolean }
): () => void {
  const key = runtimeConversationKey(address)
  const subscription = { key, listener }
  const listeners = listenersByConversation.get(key) ?? new Set()
  listeners.add(subscription)
  listenersByConversation.set(key, listeners)
  if (options?.retainWhileSubscribed !== false) {
    cancelTerminalConversationEviction(key)
    const retainingListeners = retainingListenersByConversation.get(key) ?? new Set()
    retainingListeners.add(subscription)
    retainingListenersByConversation.set(key, retainingListeners)
  }
  return () => {
    const currentKey = subscription.key
    const currentListeners = listenersByConversation.get(currentKey)
    currentListeners?.delete(subscription)
    if (currentListeners?.size === 0) listenersByConversation.delete(currentKey)
    const retainingListeners = retainingListenersByConversation.get(currentKey)
    retainingListeners?.delete(subscription)
    if (retainingListeners?.size === 0) retainingListenersByConversation.delete(currentKey)
    scheduleTerminalConversationEviction(currentKey)
  }
}

export function notifyRuntimeConversation(key: string, action?: RuntimePaneMessageAction): void {
  listenersByConversation.get(key)?.forEach(subscription => subscription.listener(action))
}

export function cacheRuntimeConversationTurns(key: string, turns: RuntimeConversationTurn[]): void {
  if (globalThis.localStorage?.getItem('wework:debug-runtime') === '1') {
    console.debug('[Wework] Runtime conversation cache update', {
      key,
      turns: turns.map(turn => ({
        id: turn.id,
        status: turn.status,
        items: turn.items.map(item => ({
          id: item.id,
          type: item.type === 'block' ? item.block.type : item.type,
          ...(item.type === 'block' && { parentToolUseId: item.block.parentToolUseId }),
        })),
      })),
    })
  }
  projectedMessagesByConversation.delete(key)
  cacheBoundedEntry(turnsByConversation, key, turns, evictedKey => {
    projectedMessagesByConversation.delete(evictedKey)
    cancelPendingStreamingNotification(evictedKey)
    cancelTerminalConversationEviction(evictedKey)
  })
  reconcileAcceptedQueuedMessages(key, turns)
  scheduleTerminalConversationEviction(key)
}

export function cacheRuntimeConversationQueuedMessagesByKey(
  key: string,
  messages: RuntimePaneQueuedMessage[]
): void {
  if (messages.length === 0) {
    queuedMessagesByConversation.delete(key)
    scheduleTerminalConversationEviction(key)
  } else {
    cancelTerminalConversationEviction(key)
    cacheBoundedEntry(queuedMessagesByConversation, key, messages)
  }
  notifyRuntimeConversation(key)
}

function reconcileAcceptedQueuedMessages(key: string, turns: RuntimeConversationTurn[]): void {
  const queuedMessages = queuedMessagesByConversation.get(key)
  if (!queuedMessages) return
  const remaining = queuedMessages.filter(
    message =>
      message.status !== 'sending' ||
      message.deliveryMode !== 'message' ||
      !turns.some(turn => turn.id !== null && turnContainsClientUserMessage(turn, message.id))
  )
  if (remaining.length === queuedMessages.length) return
  cacheRuntimeConversationQueuedMessagesByKey(key, remaining)
}

export function turnContainsClientUserMessage(
  turn: RuntimeConversationTurn,
  clientUserMessageId: string | undefined
): boolean {
  if (!clientUserMessageId) return false
  return (
    turn.clientUserMessageId === clientUserMessageId ||
    turn.items.some(item => item.type === 'user_message' && item.id === clientUserMessageId)
  )
}

export function evictRuntimeConversationKey(key: string): void {
  cancelPendingStreamingNotification(key)
  cancelTerminalConversationEviction(key)
  turnsByConversation.delete(key)
  projectedMessagesByConversation.delete(key)
  metadataByConversation.delete(key)
  goalSnapshotVersionsByConversation.delete(key)
  hydrationByConversation.delete(key)
  queuedMessagesByConversation.delete(key)
  queuedMessagesPausedByConversation.delete(key)
  interruptedGuidanceIdsByConversation.delete(key)
  evictConversationViewport(key)
}

export function getRuntimeConversationCacheStats() {
  return { messageEntries: turnsByConversation.size, ...getConversationViewportCacheStats() }
}

export function clearRuntimeConversationCacheStore(): void {
  pendingStreamingNotifications.forEach(cancel => cancel())
  terminalConversationEvictionTimers.forEach(timer => globalThis.clearTimeout(timer))
  for (const entries of conversationMaps()) {
    entries.clear()
  }
  canonicalDeviceIdByAlias.clear()
  revisionByValue = new WeakMap()
  nextRevision = 1
  clearConversationViewportCache()
}

export function cancelPendingStreamingNotification(key: string): void {
  const cancel = pendingStreamingNotifications.get(key)
  if (!cancel) return
  pendingStreamingNotifications.delete(key)
  cancel()
}

export function scheduleTerminalConversationEviction(key: string): void {
  cancelTerminalConversationEviction(key)
  if (!canEvictTerminalConversation(key)) return
  const timer = globalThis.setTimeout(() => {
    terminalConversationEvictionTimers.delete(key)
    if (!canEvictTerminalConversation(key)) return
    evictRuntimeConversationKey(key)
    notifyRuntimeConversation(key)
  }, TERMINAL_CONVERSATION_IDLE_TTL_MS)
  terminalConversationEvictionTimers.set(key, timer)
}

function canEvictTerminalConversation(key: string): boolean {
  const turns = turnsByConversation.get(key)
  return Boolean(
    turns &&
    !retainingListenersByConversation.has(key) &&
    !hydrationByConversation.has(key) &&
    (queuedMessagesByConversation.get(key)?.length ?? 0) === 0 &&
    !turns.some(turn => turn.status === 'pending' || turn.status === 'streaming')
  )
}

export function cancelTerminalConversationEviction(key: string): void {
  const timer = terminalConversationEvictionTimers.get(key)
  if (timer === undefined) return
  globalThis.clearTimeout(timer)
  terminalConversationEvictionTimers.delete(key)
}

export function cacheBoundedEntry<T>(
  entries: Map<string, T>,
  key: string,
  value: T,
  onEvict?: (key: string) => void
): void {
  if (typeof value === 'object' && value !== null) revisionByValue.set(value, nextRevision++)
  entries.delete(key)
  entries.set(key, value)
  while (entries.size > MAX_CONVERSATION_CACHE_ENTRIES) {
    const oldestKey = entries.keys().next().value
    if (oldestKey === undefined) return
    onEvict?.(oldestKey)
    entries.delete(oldestKey)
  }
}
