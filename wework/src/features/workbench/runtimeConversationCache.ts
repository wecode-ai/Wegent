export {
  getConversationScrollSnapshot,
  hasConversationScrollSnapshot,
  cacheConversationScrollSnapshot,
  getConversationVirtualMeasurements,
  cacheConversationVirtualMeasurements,
  type ConversationScrollSnapshot,
} from '@wegent/collaboration/conversation/conversationViewportCache'
import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import type { RuntimeTransportReplacedPayload } from '@/stream/chatStream'
import type {
  RuntimeGoal,
  RuntimeGoalContinuationPayload,
  RuntimeGuidanceAppliedPayload,
  RuntimePlanEventPayload,
  RuntimeSubagentActivityPayload,
  RuntimeTaskAddress,
} from '@/types/api'
import { summarizeRuntimeQueue } from '@/lib/runtime-create-diagnostics'
import type {
  ProcessingBlock,
  RuntimeConversationTurn,
  RuntimePaneQueuedMessage,
  RuntimeSubagentStatus,
  WorkbenchMessage,
} from '@/types/workbench'
import {
  appendAcceptedRuntimeConversationUser,
  appendRuntimeConversationGuidance,
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
} from './runtimeConversationTurns'
import {
  isAnsweredRequestUserInputBlock,
  isRequestUserInputBlock,
  requestUserInputPayloadKey,
} from '@wegent/chat-core/runtime-user-input'
import {
  createAppliedRuntimeGuidanceMessage,
  createOptimisticRuntimeGuidanceMessage,
} from './runtimeGuidanceMessages'
import { updateRuntimeGoalContinuation } from '@/lib/runtime-goal'
import {
  cacheBoundedEntry,
  cacheRuntimeConversationQueuedMessagesByKey,
  cacheRuntimeConversationTurns,
  cancelPendingStreamingNotification,
  cancelTerminalConversationEviction,
  clearRuntimeConversationCacheStore,
  evictRuntimeConversationKey,
  goalSnapshotVersionsByConversation,
  hydrationByConversation,
  interruptedGuidanceIdsByConversation,
  metadataByConversation,
  MAX_RUNTIME_SUBAGENT_STATUSES,
  notifyRuntimeConversation,
  pendingStreamingNotifications,
  projectedMessagesByConversation,
  queuedMessagesByConversation,
  queuedMessagesPausedByConversation,
  runtimeConversationKey,
  runtimeTransportReplacedListeners,
  turnsByConversation,
  turnContainsClientUserMessage,
  type RuntimeConversationMetadata,
} from './runtimeConversationCacheStore'
export {
  cacheRuntimeConversationQueuedMessagesByKey,
  getRuntimeConversationCacheStats,
  runtimeConversationKey,
  subscribeRuntimeConversation,
  syncRuntimeConversationDeviceAliases,
  type RuntimeConversationMetadata,
} from './runtimeConversationCacheStore'

const EMPTY_RUNTIME_CONVERSATION_TURNS: RuntimeConversationTurn[] = []
const pendingConversationOperations = new Set<{
  address: RuntimeTaskAddress
  current: boolean
  requestUserInputKey?: string | null
}>()
let nextRuntimeGoalSnapshotVersion = 1

export function beginRuntimeConversationOperation(
  address: RuntimeTaskAddress,
  options: { requestUserInputKey?: string | null } = {}
) {
  const operation = { address, current: true, ...options }
  pendingConversationOperations.add(operation)
  return {
    isCurrent: () => operation.current,
    dispose: () => {
      operation.current = false
      pendingConversationOperations.delete(operation)
    },
  }
}

const EMPTY_RUNTIME_CONVERSATION_METADATA: RuntimeConversationMetadata = {
  goal: null,
  goalContinuation: null,
  taskPlan: null,
  subagentStatuses: [],
}

export function getRuntimeConversationMetadata(
  address: RuntimeTaskAddress
): RuntimeConversationMetadata {
  return (
    touchEntry(metadataByConversation, runtimeConversationKey(address)) ??
    EMPTY_RUNTIME_CONVERSATION_METADATA
  )
}

export function setRuntimeConversationGoal(
  address: RuntimeTaskAddress,
  goal: RuntimeGoal | null
): RuntimeGoal | null {
  invalidateRuntimeGoalSnapshots(address)
  const resolvedGoal = reconcileRuntimeGoal(getRuntimeConversationMetadata(address).goal, goal)
  updateRuntimeConversationMetadata(address, current => ({
    ...current,
    goal: resolvedGoal,
    goalContinuation:
      resolvedGoal?.status === 'active'
        ? current.goalContinuation
        : updateRuntimeGoalContinuation(current.goalContinuation, { type: 'goal_inactive' }),
  }))
  return resolvedGoal
}

export function beginRuntimeGoalSnapshot(address: RuntimeTaskAddress): number {
  const key = runtimeConversationKey(address)
  const version = nextRuntimeGoalSnapshotVersion
  nextRuntimeGoalSnapshotVersion += 1
  goalSnapshotVersionsByConversation.set(key, version)
  return version
}

export function isRuntimeGoalSnapshotCurrent(
  address: RuntimeTaskAddress,
  version: number
): boolean {
  return goalSnapshotVersionsByConversation.get(runtimeConversationKey(address)) === version
}

function invalidateRuntimeGoalSnapshots(address: RuntimeTaskAddress): void {
  const key = runtimeConversationKey(address)
  goalSnapshotVersionsByConversation.set(key, nextRuntimeGoalSnapshotVersion)
  nextRuntimeGoalSnapshotVersion += 1
}

function reconcileRuntimeGoal(
  current: RuntimeGoal | null,
  next: RuntimeGoal | null
): RuntimeGoal | null {
  if (!next || !current) return next
  // A pending Goal uses the renderer clock, not the native Goal's revision clock.
  if (current.threadId === 'pending' && next.threadId !== 'pending') return next
  return next.updatedAt < current.updatedAt ? current : next
}

export function applyRuntimeConversationGoalContinuation(
  address: RuntimeTaskAddress,
  payload: RuntimeGoalContinuationPayload
): void {
  updateRuntimeConversationMetadata(address, current => ({
    ...current,
    goalContinuation: updateRuntimeGoalContinuation(current.goalContinuation, {
      type: 'turn_lifecycle',
      payload,
    }),
  }))
}

export function markRuntimeConversationAssistantStarted(address: RuntimeTaskAddress): void {
  updateRuntimeConversationMetadata(address, current => ({
    ...current,
    goalContinuation: updateRuntimeGoalContinuation(current.goalContinuation, {
      type: 'assistant_started',
    }),
  }))
}

export function setRuntimeConversationTaskPlan(
  address: RuntimeTaskAddress,
  plan: RuntimePlanEventPayload | null
): void {
  updateRuntimeConversationMetadata(address, current => ({
    ...current,
    taskPlan: plan?.plan.length ? plan : null,
  }))
}

export function applyRuntimeConversationSubagentActivity(
  address: RuntimeTaskAddress,
  activity: RuntimeSubagentActivityPayload
): void {
  updateRuntimeConversationMetadata(address, current => ({
    ...current,
    subagentStatuses: updateRuntimeSubagentStatuses(current.subagentStatuses, activity),
  }))
}

export function settleRuntimeConversationSubagents(address: RuntimeTaskAddress): void {
  updateRuntimeConversationMetadata(address, current => ({
    ...current,
    subagentStatuses: markRuntimeSubagentsSettled(current.subagentStatuses),
  }))
}

export function getRuntimeConversationMessages(address: RuntimeTaskAddress): WorkbenchMessage[] {
  const key = runtimeConversationKey(address)
  return projectRuntimeConversationMessages(
    key,
    touchEntry(turnsByConversation, key) ?? EMPTY_RUNTIME_CONVERSATION_TURNS
  )
}

export function getRuntimeConversationTurns(
  address: RuntimeTaskAddress
): RuntimeConversationTurn[] {
  const key = runtimeConversationKey(address)
  return turnsByConversation.get(key) ?? EMPTY_RUNTIME_CONVERSATION_TURNS
}

export function getRuntimeConversationMessagesForLogicalAddress(
  address: RuntimeTaskAddress
): WorkbenchMessage[] {
  const exactKey = runtimeConversationKey(address)
  if (turnsByConversation.has(exactKey) || address.deviceId !== 'local-device') {
    return projectRuntimeConversationMessages(
      exactKey,
      touchEntry(turnsByConversation, exactKey) ?? EMPTY_RUNTIME_CONVERSATION_TURNS
    )
  }

  const taskSuffix = `:${address.taskId}`
  const matchingKeys = [...turnsByConversation.keys()].filter(key => key.endsWith(taskSuffix))
  if (matchingKeys.length !== 1) return []
  const matchingKey = matchingKeys[0]
  return projectRuntimeConversationMessages(
    matchingKey,
    touchEntry(turnsByConversation, matchingKey) ?? []
  )
}

export function getRuntimeConversationTurnIds(address: RuntimeTaskAddress): ReadonlySet<string> {
  const key = runtimeConversationKey(address)
  return new Set(
    (touchEntry(turnsByConversation, key) ?? []).flatMap(turn => (turn.id ? [turn.id] : []))
  )
}

export function runtimeConversationMessageHasStartedTurn(
  address: RuntimeTaskAddress,
  messageId: string
): boolean {
  const key = runtimeConversationKey(address)
  return (touchEntry(turnsByConversation, key) ?? []).some(
    turn =>
      turn.id !== null &&
      (turn.clientUserMessageId === messageId ||
        turn.items.some(item => item.type === 'user_message' && item.id === messageId))
  )
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
  cancelTerminalConversationEviction(key)
  const token = Symbol(key)
  hydrationByConversation.set(key, { token, bufferedActions: [] })
  return token
}

export function runtimeConversationHydrationHasUpdates(
  address: RuntimeTaskAddress,
  token: symbol
): boolean {
  const hydration = hydrationByConversation.get(runtimeConversationKey(address))
  return hydration?.token === token && hydration.bufferedActions.length > 0
}

export function completeRuntimeConversationHydration(
  address: RuntimeTaskAddress,
  token: symbol,
  snapshotTurns: RuntimeConversationTurn[]
): WorkbenchMessage[] {
  const key = runtimeConversationKey(address)
  const hydration = hydrationByConversation.get(key)
  if (hydration?.token !== token) return getRuntimeConversationMessages(address)

  let turns = turnsByConversation.get(key) ?? []
  for (const action of hydration.bufferedActions) {
    turns = reduceRuntimeConversationTurns(turns, action)
  }
  turns = mergeRuntimeConversationTurns(turns, snapshotTurns)
  hydrationByConversation.delete(key)
  cacheRuntimeConversationTurns(key, turns)
  notifyHydratedRuntimeConversation(key, hydration.bufferedActions)
  return projectRuntimeConversationMessages(key, turns)
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
  cacheRuntimeConversationTurns(key, turns)
  notifyHydratedRuntimeConversation(key, hydration.bufferedActions)
  return projectRuntimeConversationMessages(key, turns)
}

export function reconcileRuntimeConversationSnapshot(
  address: RuntimeTaskAddress,
  snapshotTurns: RuntimeConversationTurn[]
): WorkbenchMessage[] {
  const key = runtimeConversationKey(address)
  const localTurns = turnsByConversation.get(key) ?? []
  const turns = mergeRuntimeConversationTurns(localTurns, snapshotTurns)
  cacheRuntimeConversationTurns(key, turns)
  notifyRuntimeConversation(key)
  return projectRuntimeConversationMessages(key, turns)
}

export function replaceRuntimeConversationSnapshot(
  address: RuntimeTaskAddress,
  snapshotTurns: RuntimeConversationTurn[]
): WorkbenchMessage[] {
  const key = runtimeConversationKey(address)
  // Terminal history can arrive before the runtime acknowledges a submitted form.
  const pendingInputKeys = new Set(
    [...pendingConversationOperations]
      .filter(operation => operation.current && runtimeConversationKey(operation.address) === key)
      .map(operation => operation.requestUserInputKey)
      .filter(Boolean)
  )
  const localTurnsById = new Map(
    (turnsByConversation.get(key) ?? []).flatMap(turn =>
      turn.id === null ? [] : ([[turn.id, turn]] as const)
    )
  )
  const turns = snapshotTurns.map(snapshotTurn => {
    if (snapshotTurn.id === null) return snapshotTurn
    const localTurn = localTurnsById.get(snapshotTurn.id)
    if (!localTurn) return snapshotTurn

    const mergedTurn = mergeRuntimeConversationTurns([localTurn], [snapshotTurn])[0]
    const authoritativeItemIds = new Set(snapshotTurn.items.map(item => item.id))
    return {
      ...mergedTurn,
      items: mergedTurn.items.filter(
        item =>
          authoritativeItemIds.has(item.id) ||
          (item.type === 'block' &&
            (isAnsweredRequestUserInputBlock(item.block) ||
              (isRequestUserInputBlock(item.block) &&
                pendingInputKeys.has(requestUserInputPayloadKey(item.block.renderPayload)))))
      ),
    }
  })
  cacheRuntimeConversationTurns(key, turns)
  notifyRuntimeConversation(key)
  return projectRuntimeConversationMessages(key, turns)
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
    const turns = turnsByConversation.get(key) ?? []
    return projectRuntimeConversationMessages(key, turns)
  }
  const currentTurns = turnsByConversation.get(key) ?? []
  const nextTurns = reduceRuntimeConversationTurns(currentTurns, action)
  cacheRuntimeConversationTurns(key, nextTurns)
  publishRuntimeConversationAction(key, action)
  return projectRuntimeConversationMessages(key, nextTurns)
}

export function appendAcceptedRuntimeConversationMessage(
  address: RuntimeTaskAddress,
  message: WorkbenchMessage,
  activeTurnId: string | null,
  turnIdsBeforeSend: ReadonlySet<string>
): WorkbenchMessage[] {
  return updateRuntimeConversationTurns(address, turns =>
    appendAcceptedRuntimeConversationUser(turns, message, activeTurnId, turnIdsBeforeSend)
  )
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
  const hydration = hydrationByConversation.get(runtimeConversationKey(address))
  if (hydration && identity.clientUserMessageId) {
    hydration.bufferedActions = hydration.bufferedActions.filter(
      action => action.type !== 'user_added' || action.message.id !== identity.clientUserMessageId
    )
  }
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
  cacheRuntimeConversationTurns(key, nextTurns)
  notifyRuntimeConversation(key)
  return projectRuntimeConversationMessages(key, nextTurns)
}

export function getRuntimeConversationQueuedMessages(
  address: RuntimeTaskAddress
): RuntimePaneQueuedMessage[] {
  return getRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(address))
}

export function getRuntimeConversationQueuedMessagesByKey(key: string): RuntimePaneQueuedMessage[] {
  return touchEntry(queuedMessagesByConversation, key) ?? []
}

export function getRuntimeConversationQueueDiagnosticSnapshotByKey(
  key: string,
  messageId?: string
) {
  // Observing a queue must not change its cache eviction priority.
  const messages = queuedMessagesByConversation.get(key) ?? []
  return {
    paused: queuedMessagesPausedByConversation.get(key) ?? false,
    ...summarizeRuntimeQueue(messages),
    ...(messageId === undefined
      ? {}
      : { queueMessagePresent: messages.some(message => message.id === messageId) }),
  }
}

export function cacheRuntimeConversationQueuedMessages(
  address: RuntimeTaskAddress,
  messages: RuntimePaneQueuedMessage[]
) {
  cacheRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(address), messages)
}

export function settleRuntimeConversationAcceptedMessage(
  address: RuntimeTaskAddress,
  messageId?: string
): void {
  const key = runtimeConversationKey(address)
  const queuedMessages = queuedMessagesByConversation.get(key)
  if (!queuedMessages) return

  const nextQueuedMessages = queuedMessages.filter(message => {
    if (message.status !== 'sending' || message.deliveryMode !== 'message') return true
    if (messageId) return message.id !== messageId
    return message.awaitingTurnStart !== true
  })
  if (nextQueuedMessages.length === queuedMessages.length) return

  cacheRuntimeConversationQueuedMessagesByKey(key, nextQueuedMessages)
}

export function reconcileRuntimeConversationQueueAfterTransportReplacement(
  address: RuntimeTaskAddress,
  snapshotTurns: RuntimeConversationTurn[]
): void {
  const key = runtimeConversationKey(address)
  const queuedMessages = queuedMessagesByConversation.get(key)
  if (!queuedMessages) return

  const acceptedMessageIds = new Set<string>()
  for (const turn of snapshotTurns) {
    if (turn.clientUserMessageId) acceptedMessageIds.add(turn.clientUserMessageId)
    for (const item of turn.items) {
      if (item.type === 'user_message' && item.id) acceptedMessageIds.add(item.id)
    }
  }

  const nextQueuedMessages = queuedMessages.flatMap(message => {
    if (acceptedMessageIds.has(message.id)) return []
    if (message.status !== 'sending') return [message]
    return [
      {
        ...message,
        status: 'queued' as const,
        deliveryMode: undefined,
        awaitingTurnStart: undefined,
        error: undefined,
        notice: undefined,
      },
    ]
  })
  if (
    nextQueuedMessages.length === queuedMessages.length &&
    nextQueuedMessages.every((message, index) => message === queuedMessages[index])
  ) {
    return
  }

  cacheRuntimeConversationQueuedMessagesByKey(key, nextQueuedMessages)
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

  const queuedGuidance = takeAppliedRuntimeConversationGuidance(address, payload)
  const guidanceMessage =
    queuedGuidance ??
    (payload.clientGuidanceId && payload.message
      ? {
          id: payload.clientGuidanceId,
          content: payload.message,
          status: 'sending',
          deliveryMode: 'guidance',
          createdAt: new Date(payload.appliedAtMs).toISOString(),
        }
      : null)
  if (!guidanceMessage) return null

  if (queuedGuidance && takeInterruptedRuntimeConversationGuidance(address, guidanceMessage.id)) {
    notifyRuntimeConversation(key)
    return guidanceMessage
  }

  const appliedGuidance = createAppliedRuntimeGuidanceMessage(guidanceMessage, payload)
  const nextTurns = appendRuntimeConversationGuidance(turns, payload.subtaskId, appliedGuidance)
  cacheRuntimeConversationTurns(key, nextTurns)
  notifyRuntimeConversation(key)
  return guidanceMessage
}

export function appendOptimisticRuntimeConversationGuidance(
  address: RuntimeTaskAddress,
  turnId: string,
  guidanceMessage: RuntimePaneQueuedMessage
): WorkbenchMessage[] {
  return updateRuntimeConversationTurns(address, turns =>
    appendRuntimeConversationGuidance(
      turns,
      turnId,
      createOptimisticRuntimeGuidanceMessage(guidanceMessage)
    )
  )
}

export function removeOptimisticRuntimeConversationGuidance(
  address: RuntimeTaskAddress,
  clientGuidanceId: string
): WorkbenchMessage[] {
  return updateRuntimeConversationTurns(address, turns =>
    turns.map(turn => ({
      ...turn,
      items: turn.items.filter(
        item => item.type !== 'user_message' || item.id !== clientGuidanceId
      ),
    }))
  )
}

export interface OptimisticRuntimeTurnInterruption {
  turnId: string | null
  clientUserMessageId?: string
  status: RuntimeConversationTurn['status']
  completedAt?: RuntimeConversationTurn['completedAt']
  stoppedNotice?: RuntimeConversationTurn['stoppedNotice']
}

export function optimisticallyInterruptRuntimeConversation(
  address: RuntimeTaskAddress
): OptimisticRuntimeTurnInterruption | null {
  let interrupted: OptimisticRuntimeTurnInterruption | null = null
  updateRuntimeConversationTurns(address, turns => {
    const index = turns.findLastIndex(
      turn => turn.status === 'pending' || turn.status === 'streaming'
    )
    if (index < 0) return turns
    const turn = turns[index]
    interrupted = {
      turnId: turn.id,
      clientUserMessageId: turn.clientUserMessageId,
      status: turn.status,
      completedAt: turn.completedAt,
      stoppedNotice: turn.stoppedNotice,
    }
    return turns.map((current, currentIndex) =>
      currentIndex === index
        ? {
            ...current,
            status: 'cancelled',
            completedAt: new Date().toISOString(),
            stoppedNotice: true,
          }
        : current
    )
  })
  return interrupted
}

export function restoreOptimisticallyInterruptedRuntimeConversation(
  address: RuntimeTaskAddress,
  interruption: OptimisticRuntimeTurnInterruption
): WorkbenchMessage[] {
  return updateRuntimeConversationTurns(address, turns =>
    turns.map(turn =>
      runtimeTurnMatchesInterruption(turn, interruption)
        ? {
            ...turn,
            status: interruption.status,
            completedAt: interruption.completedAt,
            stoppedNotice: interruption.stoppedNotice,
          }
        : turn
    )
  )
}

function runtimeTurnMatchesInterruption(
  turn: RuntimeConversationTurn,
  interruption: OptimisticRuntimeTurnInterruption
): boolean {
  if (interruption.turnId !== null) return turn.id === interruption.turnId
  return (
    turn.id === null &&
    Boolean(interruption.clientUserMessageId) &&
    turn.clientUserMessageId === interruption.clientUserMessageId
  )
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
  const previous = queuedMessagesPausedByConversation.get(key) ?? false
  if (previous === paused) return
  if (!paused) {
    queuedMessagesPausedByConversation.delete(key)
  } else {
    cacheBoundedEntry(queuedMessagesPausedByConversation, key, true)
  }
  notifyRuntimeConversation(key)
}

function updateRuntimeConversationMetadata(
  address: RuntimeTaskAddress,
  update: (current: RuntimeConversationMetadata) => RuntimeConversationMetadata
): void {
  const key = runtimeConversationKey(address)
  const current = metadataByConversation.get(key) ?? EMPTY_RUNTIME_CONVERSATION_METADATA
  const next = update(current)
  if (next === current) return
  cacheBoundedEntry(metadataByConversation, key, next)
  notifyRuntimeConversation(key)
}

function updateRuntimeSubagentStatuses(
  current: RuntimeSubagentStatus[],
  activity: RuntimeSubagentActivityPayload
): RuntimeSubagentStatus[] {
  const agentPath = activity.agentPath.trim()
  if (!agentPath) return current

  const agentId = runtimeSubagentId(activity)
  const previousStatus = current.find(item => item.id === agentId)
  const nextStatus: RuntimeSubagentStatus = {
    id: agentId,
    agentId,
    agentPath,
    agentName:
      activity.agentName?.trim() || previousStatus?.agentName || runtimeSubagentName(agentId),
    status: normalizeRuntimeSubagentStatus(activity.status ?? activity.kind),
    kind: activity.kind,
    updatedAtMs: activity.occurredAtMs ?? Date.now(),
  }

  return [nextStatus, ...current.filter(item => item.id !== agentId)]
    .sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0))
    .slice(0, MAX_RUNTIME_SUBAGENT_STATUSES)
}

function markRuntimeSubagentsSettled(current: RuntimeSubagentStatus[]): RuntimeSubagentStatus[] {
  let changed = false
  const settled = current.map(status => {
    if (status.status !== 'running') return status
    changed = true
    return {
      ...status,
      status: 'done' as const,
      updatedAtMs: Date.now(),
    }
  })
  return changed ? settled : current
}

function normalizeRuntimeSubagentStatus(
  value: string | undefined
): RuntimeSubagentStatus['status'] {
  const normalized = value?.replace(/_/g, '').toLowerCase()
  if (normalized === 'done' || normalized === 'completed' || normalized === 'taskcomplete') {
    return 'done'
  }
  if (normalized === 'interrupted' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'interrupted'
  }
  return 'running'
}

function runtimeSubagentId(activity: RuntimeSubagentActivityPayload): string {
  const agentId = activity.agentId?.trim()
  if (agentId) return agentId

  const threadId = activity.agentThreadId?.trim()
  if (threadId) return threadId

  const agentPath = activity.agentPath.trim()
  if (agentPath.startsWith('thread:')) {
    return agentPath.slice('thread:'.length).trim() || agentPath
  }
  return agentPath
}

function runtimeSubagentName(agentId: string): string {
  const parts = agentId.split('/').filter(Boolean)
  const lastPart = parts.at(-1) ?? agentId
  if (!lastPart || lastPart.startsWith('019') || lastPart.length > 16) {
    return `Agent ${shortRuntimeAgentId(agentId)}`
  }
  return lastPart
}

function shortRuntimeAgentId(agentId: string): string {
  const normalized = agentId.replace(/^thread:/, '').trim()
  return normalized.length > 8 ? normalized.slice(-8) : normalized || 'subagent'
}

export function evictRuntimeConversation(address: RuntimeTaskAddress) {
  const key = runtimeConversationKey(address)
  // Explicit archival invalidates pending work; ordinary LRU/idle eviction does not.
  for (const operation of pendingConversationOperations) {
    if (runtimeConversationKey(operation.address) !== key) continue
    operation.current = false
    pendingConversationOperations.delete(operation)
  }
  evictRuntimeConversationKey(key)
}

export function clearRuntimeConversationCacheForTests() {
  pendingConversationOperations.forEach(operation => {
    operation.current = false
  })
  pendingConversationOperations.clear()
  clearRuntimeConversationCacheStore()
  nextRuntimeGoalSnapshotVersion = 1
}

function publishRuntimeConversationAction(key: string, action: RuntimePaneMessageAction): void {
  if (isStreamingConversationAction(action)) {
    scheduleStreamingConversationNotification(key)
    return
  }
  cancelPendingStreamingNotification(key)
  notifyRuntimeConversation(key, action)
}

function scheduleStreamingConversationNotification(key: string): void {
  if (pendingStreamingNotifications.has(key)) return

  const flush = () => {
    pendingStreamingNotifications.delete(key)
    notifyRuntimeConversation(key)
  }
  if (typeof requestAnimationFrame === 'function') {
    const frame = requestAnimationFrame(flush)
    pendingStreamingNotifications.set(key, () => cancelAnimationFrame(frame))
    return
  }

  const timer = globalThis.setTimeout(flush, 16)
  pendingStreamingNotifications.set(key, () => globalThis.clearTimeout(timer))
}

function isStreamingConversationAction(action: RuntimePaneMessageAction): boolean {
  return action.type === 'assistant_chunk' || action.type === 'block_updated'
}

function notifyHydratedRuntimeConversation(
  key: string,
  bufferedActions: RuntimePaneMessageAction[]
): void {
  if (bufferedActions.length === 0) {
    notifyRuntimeConversation(key)
    return
  }
  bufferedActions.forEach(action => publishRuntimeConversationAction(key, action))
}

function touchEntry<T>(entries: Map<string, T>, key: string): T | undefined {
  const value = entries.get(key)
  if (value === undefined) return undefined
  entries.delete(key)
  entries.set(key, value)
  return value
}

function projectRuntimeConversationMessages(
  key: string,
  turns: RuntimeConversationTurn[]
): WorkbenchMessage[] {
  const cached = projectedMessagesByConversation.get(key)
  if (cached?.turns === turns) return cached.messages

  const messages = projectRuntimeConversationTurns(turns)
  cacheBoundedEntry(projectedMessagesByConversation, key, { turns, messages })
  return messages
}
