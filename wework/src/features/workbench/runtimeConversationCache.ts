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
import type {
  RuntimeConversationTurn,
  RuntimePaneQueuedMessage,
  RuntimeSubagentStatus,
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
import {
  createAppliedRuntimeGuidanceMessage,
  createOptimisticRuntimeGuidanceMessage,
} from './runtimeGuidanceMessages'
import { updateRuntimeGoalContinuation } from '@/lib/runtime-goal'

const MAX_CONVERSATION_CACHE_ENTRIES = 50
const RUNTIME_CONVERSATION_LOG_TURN_LIMIT = 6
const RUNTIME_CONVERSATION_LOG_ITEM_LIMIT = 12
const RUNTIME_CONVERSATION_LOG_ACTION_LIMIT = 20
const RUNTIME_CONVERSATION_LOG_MESSAGE_LIMIT = 10
const turnsByConversation = new Map<string, RuntimeConversationTurn[]>()
const metadataByConversation = new Map<string, RuntimeConversationMetadata>()
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

export interface RuntimeConversationMetadata {
  goal: RuntimeGoal | null
  goalContinuation: RuntimeGoalContinuationPayload | null
  taskPlan: RuntimePlanEventPayload | null
  subagentStatuses: RuntimeSubagentStatus[]
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
): void {
  updateRuntimeConversationMetadata(address, current => {
    const resolvedGoal = reconcileRuntimeGoal(current.goal, goal)
    return {
      ...current,
      goal: resolvedGoal,
      goalContinuation:
        resolvedGoal?.status === 'active'
          ? current.goalContinuation
          : updateRuntimeGoalContinuation(current.goalContinuation, { type: 'goal_inactive' }),
    }
  })
}

function reconcileRuntimeGoal(
  current: RuntimeGoal | null,
  next: RuntimeGoal | null
): RuntimeGoal | null {
  if (!next || !current) return next
  if (next.updatedAt > current.updatedAt) return next
  if (next.updatedAt < current.updatedAt) return current
  if (next.status === 'complete' && current.status !== 'complete') return next
  return current
}

export function applyRuntimeConversationGoalContinuation(
  address: RuntimeTaskAddress,
  payload: RuntimeGoalContinuationPayload
): void {
  const key = runtimeConversationKey(address)
  logRuntimeConversationState('goal-continuation', key, turnsByConversation.get(key) ?? [], {
    continuation: {
      status: payload.status,
      turnId: payload.turnId ?? null,
      subtaskId: payload.subtaskId ?? null,
      threadId: payload.threadId ?? null,
    },
  })
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
  if (existing) {
    logRuntimeConversationState(
      'hydrate:reuse',
      key,
      turnsByConversation.get(key) ?? [],
      summarizeBufferedRuntimeActions(existing.bufferedActions)
    )
    return existing.token
  }
  const token = Symbol(key)
  hydrationByConversation.set(key, { token, bufferedActions: [] })
  logRuntimeConversationState('hydrate:begin', key, turnsByConversation.get(key) ?? [])
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

  const localTurns = turnsByConversation.get(key) ?? []
  logRuntimeConversationState('hydrate:before', key, localTurns, {
    snapshot: summarizeRuntimeConversationTurns(snapshotTurns),
    ...summarizeBufferedRuntimeActions(hydration.bufferedActions),
  })
  let turns = mergeRuntimeConversationTurns(localTurns, snapshotTurns)
  for (const action of hydration.bufferedActions) {
    turns = reduceRuntimeConversationTurns(turns, action)
  }
  logRuntimeConversationState('hydrate:after', key, turns)
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

  logRuntimeConversationState(
    'hydrate:abort',
    key,
    turnsByConversation.get(key) ?? [],
    summarizeBufferedRuntimeActions(hydration.bufferedActions)
  )
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
  logRuntimeConversationState('snapshot:before', key, localTurns, {
    snapshot: summarizeRuntimeConversationTurns(snapshotTurns),
  })
  const turns = mergeRuntimeConversationTurns(localTurns, snapshotTurns)
  logRuntimeConversationState('snapshot:after', key, turns)
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
    logRuntimeConversationState('action:buffered', key, turnsByConversation.get(key) ?? [], {
      action: summarizeRuntimeConversationAction(action),
      bufferedActionCount: hydration.bufferedActions.length,
    })
    return projectRuntimeConversationTurns(turnsByConversation.get(key) ?? [])
  }
  const currentTurns = turnsByConversation.get(key) ?? []
  logRuntimeConversationState('action:before', key, currentTurns, {
    action: summarizeRuntimeConversationAction(action),
  })
  const nextTurns = reduceRuntimeConversationTurns(currentTurns, action)
  logRuntimeConversationState('action:after', key, nextTurns, {
    action: summarizeRuntimeConversationAction(action),
  })
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

export function settleRuntimeConversationAcceptedMessage(address: RuntimeTaskAddress): void {
  const key = runtimeConversationKey(address)
  const queuedMessages = queuedMessagesByConversation.get(key)
  if (!queuedMessages) return

  const nextQueuedMessages = queuedMessages.filter(
    message => message.status !== 'sending' || message.deliveryMode !== 'message'
  )
  if (nextQueuedMessages.length === queuedMessages.length) return

  cacheRuntimeConversationQueuedMessagesByKey(key, nextQueuedMessages)
  notifyRuntimeConversation(key)
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
  cacheBoundedEntry(turnsByConversation, key, nextTurns)
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

function logRuntimeConversationState(
  stage: string,
  key: string,
  turns: RuntimeConversationTurn[],
  details: Record<string, unknown> = {}
): void {
  console.info('[Wework] Runtime canonical conversation', {
    stage,
    conversationKey: key,
    turns: summarizeRuntimeConversationTurns(turns),
    projection: summarizeRuntimeConversationMessages(projectRuntimeConversationTurns(turns)),
    ...details,
  })
}

function summarizeRuntimeConversationTurns(turns: RuntimeConversationTurn[]) {
  const firstIncludedTurnIndex = Math.max(0, turns.length - RUNTIME_CONVERSATION_LOG_TURN_LIMIT)
  return {
    totalTurnCount: turns.length,
    omittedTurnCount: firstIncludedTurnIndex,
    tail: turns.slice(firstIncludedTurnIndex).map((turn, relativeIndex) => {
      const firstIncludedItemIndex = Math.max(
        0,
        turn.items.length - RUNTIME_CONVERSATION_LOG_ITEM_LIMIT
      )
      const lastAssistantTextIndex = turn.items.findLastIndex(
        item => item.type === 'assistant_text'
      )
      return {
        turnIndex: firstIncludedTurnIndex + relativeIndex,
        turnId: turn.id,
        clientUserMessageId: turn.clientUserMessageId ?? null,
        runtimeMessageIndex: turn.runtimeMessageIndex ?? null,
        status: turn.status,
        completedAt: turn.completedAt ?? null,
        itemCount: turn.items.length,
        omittedItemCount: firstIncludedItemIndex,
        assistantTextFollowedByBlock:
          lastAssistantTextIndex >= 0 &&
          turn.items.slice(lastAssistantTextIndex + 1).some(item => item.type === 'block'),
        itemTail: turn.items.slice(firstIncludedItemIndex).map((item, itemRelativeIndex) => ({
          itemIndex: firstIncludedItemIndex + itemRelativeIndex,
          itemId: item.id,
          itemType: item.type,
          createdAt:
            item.type === 'user_message'
              ? (item.message.createdAt ?? null)
              : item.type === 'assistant_text'
                ? item.createdAt
                : item.block.createdAt,
          contentLength:
            item.type === 'user_message'
              ? item.message.content.length
              : item.type === 'assistant_text'
                ? item.content.length
                : item.block.type === 'text'
                  ? item.block.content.length
                  : null,
          blockType: item.type === 'block' ? item.block.type : null,
          blockStatus: item.type === 'block' ? item.block.status : null,
          blockSubtaskId: item.type === 'block' ? item.block.subtaskId : null,
        })),
      }
    }),
  }
}

function summarizeRuntimeConversationAction(action: RuntimePaneMessageAction) {
  return {
    type: action.type,
    subtaskId: 'subtaskId' in action ? (action.subtaskId ?? null) : null,
    clientUserMessageId:
      'clientUserMessageId' in action ? (action.clientUserMessageId ?? null) : null,
    itemId: 'itemId' in action ? (action.itemId ?? null) : null,
    blockId:
      action.type === 'block_created'
        ? action.block.id
        : action.type === 'block_updated'
          ? action.blockId
          : null,
    contentLength:
      action.type === 'assistant_chunk' || action.type === 'assistant_done'
        ? (action.content?.length ?? 0)
        : null,
    contentMode: action.type === 'assistant_chunk' ? (action.contentMode ?? null) : null,
    offset: action.type === 'assistant_chunk' ? (action.offset ?? null) : null,
    blockCount:
      action.type === 'assistant_chunk' ||
      action.type === 'assistant_cached' ||
      action.type === 'assistant_done'
        ? (action.blocks?.length ?? 0)
        : action.type === 'block_created'
          ? 1
          : null,
  }
}

function summarizeBufferedRuntimeActions(actions: RuntimePaneMessageAction[]) {
  const firstIncludedActionIndex = Math.max(
    0,
    actions.length - RUNTIME_CONVERSATION_LOG_ACTION_LIMIT
  )
  return {
    bufferedActionCount: actions.length,
    omittedBufferedActionCount: firstIncludedActionIndex,
    bufferedActionTail: actions
      .slice(firstIncludedActionIndex)
      .map(summarizeRuntimeConversationAction),
  }
}

function summarizeRuntimeConversationMessages(messages: WorkbenchMessage[]) {
  const firstIncludedMessageIndex = Math.max(
    0,
    messages.length - RUNTIME_CONVERSATION_LOG_MESSAGE_LIMIT
  )
  return {
    totalMessageCount: messages.length,
    omittedMessageCount: firstIncludedMessageIndex,
    tail: messages.slice(firstIncludedMessageIndex).map((message, relativeIndex) => {
      const blockSubtaskIds = Array.from(
        new Set((message.blocks ?? []).flatMap(block => (block.subtaskId ? [block.subtaskId] : [])))
      )
      return {
        messageIndex: firstIncludedMessageIndex + relativeIndex,
        messageId: message.id,
        role: message.role,
        status: message.status,
        turnId: message.turnId ?? null,
        subtaskId: message.subtaskId ?? null,
        runtimeMessageIndex: message.runtimeMessageIndex ?? null,
        contentLength: message.content.length,
        blockCount: message.blocks?.length ?? 0,
        blockSubtaskIds,
        hasForeignTurnBlocks:
          message.role === 'assistant' &&
          Boolean(message.turnId) &&
          blockSubtaskIds.some(subtaskId => subtaskId !== message.turnId),
      }
    }),
  }
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

  return [...current.filter(item => item.id !== agentId), nextStatus].sort(
    (left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0)
  )
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
  turnsByConversation.delete(key)
  metadataByConversation.delete(key)
  hydrationByConversation.delete(key)
  queuedMessagesByConversation.delete(key)
  queuedMessagesPausedByConversation.delete(key)
  interruptedGuidanceIdsByConversation.delete(key)
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
  metadataByConversation.clear()
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
