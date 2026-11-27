import type { GuidanceWorkbenchMessage } from '@/types/workbench'
export const EMPTY_PANE_GUIDANCE_MESSAGES: GuidanceWorkbenchMessage[] = []
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

import type { RuntimeGoal, RuntimeTaskAddress } from '@/types/api'
import { getDesktopE2EInjectedConfig } from '@/e2e/runtime-config'
import type {
  RuntimePaneQueuedMessage,
  RuntimePaneTranscript,
  WorkbenchMessage,
} from '@/types/workbench'

import {
  getRuntimeConversationMetadata,
  getRuntimeConversationQueuedMessagesByKey,
  removeRuntimeConversationTurn,
  runtimeConversationKey,
} from '@/features/workbench/runtimeConversationCache'

import type { RuntimeTaskLoadTarget, PendingRuntimeGoalState } from './workbenchPaneSessionTypes'
export const runtimePaneGoalSeeds = new Map<string, PendingRuntimeGoalState>()

export const DEFAULT_RUNTIME_TRANSCRIPT_PAGE_SIZE = 5

export const MAX_CACHED_RUNTIME_PANE_GOALS = 3

export function resolveRuntimeTranscriptPageSize(
  configuredPageSize = Number(
    getDesktopE2EInjectedConfig().transcriptPageSize ??
      import.meta.env.VITE_WEWORK_E2E_TRANSCRIPT_PAGE_SIZE
  )
): number {
  return Number.isInteger(configuredPageSize) && configuredPageSize > 0
    ? configuredPageSize
    : DEFAULT_RUNTIME_TRANSCRIPT_PAGE_SIZE
}

export function runtimeTranscriptHasMoreBefore(transcript: RuntimePaneTranscript): boolean {
  return Boolean(transcript.beforeCursor || transcript.hasMoreBefore)
}

export function rollbackRejectedRuntimeConversationTurn(
  target: RuntimeTaskAddress,
  activeTarget: RuntimeTaskAddress | null,
  clientUserMessageId: string
): WorkbenchMessage[] | null {
  const messages = removeRuntimeConversationTurn(target, { clientUserMessageId })
  if (
    !activeTarget ||
    runtimeTranscriptPaneIdentityKey(activeTarget) !== runtimeTranscriptPaneIdentityKey(target)
  ) {
    return null
  }
  return messages
}

export function isInterruptedGuidance(message: RuntimePaneQueuedMessage): boolean {
  return message.status === 'sending' && message.deliveryMode === 'guidance'
}

export function runtimeTaskLoadTargetFromAddress(
  address: RuntimeTaskAddress
): RuntimeTaskLoadTarget {
  return {
    key: runtimeTaskLoadAddressKey(address),
    identityKey: runtimeTranscriptPaneIdentityKey(address),
    address,
  }
}

export const runtimeTranscriptPaneKey = runtimeConversationKey

export function runtimeTaskLoadAddressKey(address: RuntimeTaskAddress): string {
  const runtimeHandleThreadId =
    typeof address.runtimeHandle?.threadId === 'string'
      ? address.runtimeHandle.threadId.trim()
      : typeof address.runtimeHandle?.thread_id === 'string'
        ? address.runtimeHandle.thread_id.trim()
        : ''

  return JSON.stringify({
    // Workspace discovery can enrich the address without replacing the transcript.
    identity: runtimeTranscriptPaneIdentityKey(address),
    projectSession: address.projectSession ?? null,
    runtime: address.runtime ?? null,
    threadId: address.threadId?.trim() || runtimeHandleThreadId || null,
    workspaceKind: address.workspaceKind ?? null,
    worktreeId: address.worktreeId ?? null,
  })
}

export function runtimeTranscriptPaneIdentityKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.taskId}`
}

export function isPendingGoalVisibleForRuntimeTarget(
  pendingGoalState: PendingRuntimeGoalState,
  address: RuntimeTaskAddress
): boolean {
  if (!pendingGoalState.targetKey && !pendingGoalState.targetIdentityKey) return true
  return (
    pendingGoalState.targetKey === runtimeTranscriptPaneKey(address) ||
    pendingGoalState.targetIdentityKey === runtimeTranscriptPaneIdentityKey(address)
  )
}

export function isUnboundPendingGoalState(pendingGoalState: PendingRuntimeGoalState): boolean {
  return !pendingGoalState.targetKey && !pendingGoalState.targetIdentityKey
}

export function pendingRuntimeGoalState(
  goal: RuntimeGoal,
  address: RuntimeTaskAddress
): PendingRuntimeGoalState {
  return {
    goal,
    targetKey: runtimeTranscriptPaneKey(address),
    targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
  }
}

export function seedRuntimePaneGoal(
  address: RuntimeTaskAddress,
  goal: RuntimeGoal,
  ownerKey: string
) {
  setLruMapValue(
    runtimePaneGoalSeeds,
    JSON.stringify([ownerKey, runtimeTranscriptPaneIdentityKey(address)]),
    pendingRuntimeGoalState(goal, address),
    MAX_CACHED_RUNTIME_PANE_GOALS
  )
}

export function getRuntimePaneGoalSeed(
  address: RuntimeTaskAddress,
  ownerKey: string
): PendingRuntimeGoalState | null {
  return (
    getLruMapValue(
      runtimePaneGoalSeeds,
      JSON.stringify([ownerKey, runtimeTranscriptPaneIdentityKey(address)])
    ) ?? null
  )
}

export function clearRuntimePaneGoalSeed(address: RuntimeTaskAddress, ownerKey: string) {
  runtimePaneGoalSeeds.delete(JSON.stringify([ownerKey, runtimeTranscriptPaneIdentityKey(address)]))
}

export function resolveHydratedRuntimeGoal(
  address: RuntimeTaskAddress,
  loadedGoal: RuntimeGoal | null,
  seededGoal: PendingRuntimeGoalState | null,
  ownerKey: string
): RuntimeGoal | null {
  if (loadedGoal) return loadedGoal

  const hasQueuedGoal = getRuntimeConversationQueuedMessagesByKey(
    runtimeConversationKey(address)
  ).some(
    message =>
      Boolean(message.initialGoal) && (message.status === 'queued' || message.status === 'sending')
  )
  if (hasQueuedGoal) {
    const optimisticGoal = getRuntimeConversationMetadata(address).goal
    if (optimisticGoal) return optimisticGoal
  }

  if (
    seededGoal?.goal.threadId === 'pending' &&
    getRuntimePaneGoalSeed(address, ownerKey) === seededGoal
  ) {
    return seededGoal.goal
  }

  return null
}

export function runtimeAddressDebug(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? null,
    hasRuntimeHandle: Boolean(address.runtimeHandle),
    runtimeHandleKeys: address.runtimeHandle ? Object.keys(address.runtimeHandle).sort() : [],
  }
}

export function summarizeWorkbenchMessages(
  messages: WorkbenchMessage[]
): Record<string, unknown>[] {
  return messages.map(message => ({
    id: message.id,
    role: message.role,
    status: message.status,
    runtimeStatus: message.runtimeStatus,
    contentLength: message.content.length,
    subtaskId: message.subtaskId ?? null,
    turnId: message.turnId ?? null,
  }))
}

export function debugRuntimePaneMessageFlow(event: string, details: Record<string, unknown>) {
  if (!event.startsWith('transcript-load-') && !isRuntimeDebugEnabled()) return
  if (
    event.startsWith('transcript-load-') &&
    (import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true')
  ) {
    logRuntimeTaskCreateStage(event, details)
  }
  if (isRuntimeDebugEnabled()) {
    console.debug('[Wework] Runtime pane message flow', {
      event,
      ...details,
    })
  }
}

export function isRuntimeDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem('wework:debug-runtime') === '1'
}

export function isEditableLastUserMessage(
  messages: WorkbenchMessage[],
  targetIndex: number
): boolean {
  if (targetIndex < 0 || targetIndex >= messages.length) return false

  const target = messages[targetIndex]
  if (target.role !== 'user') return false

  const followingMessages = messages.slice(targetIndex + 1)
  if (followingMessages.length === 0) return false
  if (followingMessages.some(message => message.role === 'user')) return false
  if (followingMessages.some(message => message.status === 'streaming')) return false

  return followingMessages.some(message => message.role === 'assistant')
}

export function getLruMapValue<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key)
  if (value === undefined) return undefined
  map.delete(key)
  map.set(key, value)
  return value
}

export function setLruMapValue<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number) {
  map.delete(key)
  map.set(key, value)

  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) return
    map.delete(oldestKey)
  }
}

export function scheduleRuntimeTurnNavigationLoad(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const requestId = window.requestIdleCallback(callback, { timeout: 2000 })
    return () => window.cancelIdleCallback(requestId)
  }
  const timeoutId = window.setTimeout(callback, 0)
  return () => window.clearTimeout(timeoutId)
}

export function isRuntimeTaskAddress(value: unknown): value is RuntimeTaskAddress {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RuntimeTaskAddress>
  return typeof candidate.deviceId === 'string' && typeof candidate.taskId === 'string'
}

export function createPendingRuntimeGoal(objective: string): RuntimeGoal {
  const now = Date.now()
  return {
    threadId: 'pending',
    objective,
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  }
}
