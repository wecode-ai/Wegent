import type { ChatStreamHandlers, RuntimeTransportReplacedPayload } from '@/stream/chatStream'
import type {
  Attachment,
  ChatBlock,
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatStartPayload,
  ChatBlockCreatedPayload,
  ChatBlockUpdatedPayload,
  RuntimeContextUsage,
  RuntimeGoalEventPayload,
  RuntimeGoalContinuationPayload,
  RuntimePlanEventPayload,
  RuntimeGuidanceAppliedPayload,
  RuntimeMessagePresentationReference,
  RuntimeSubagentActivityPayload,
  RuntimeSupervisorEventPayload,
  NormalizedRuntimeMessage,
  RuntimeTaskAddress,
  RuntimeTranscriptTurn,
  TurnFileChangesSummary,
} from '@/types/api'
import type {
  MessageSource,
  ProcessingBlock,
  RuntimeConversationItem,
  RuntimeConversationTurn,
  WorkbenchMessage,
} from '@/types/workbench'
import { stripCodexUiDirectives } from '@/lib/codex-directives'
import { mergeTurnFileChanges, normalizeTurnFileChanges } from './turnFileChanges'
import { normalizeWorkbenchBlockStatus, type WorkbenchMessageAction } from '@wegent/chat-core'

const RUNTIME_MESSAGE_CONTENT_TRUNCATION_THRESHOLD_CHARS = 200_000

export type RuntimePaneMessageAction = WorkbenchMessageAction<Attachment, TurnFileChangesSummary>

export interface RuntimeTaskStreamHandlers {
  onMessageAction: (action: RuntimePaneMessageAction) => void
  onAssistantStart?: (turnId: string) => void
  onAssistantFirstToken?: (turnId: string) => void
  onAssistantResponseSize?: (turnId: string, responseSizeBytes: number) => void
  onAssistantSettled?: (turnId: string, outcome: 'succeeded' | 'failed' | 'cancelled') => void
  onRefreshWorkLists?: () => void
  onContextUsageUpdated?: (usage: RuntimeContextUsage) => void
  onSubagentActivity?: (payload: RuntimeSubagentActivityPayload) => void
  onRuntimeGoalUpdated?: (payload: RuntimeGoalEventPayload) => void
  onRuntimeGoalCleared?: (payload: RuntimeGoalEventPayload) => void
  onRuntimeSupervisorUpdated?: (payload: RuntimeSupervisorEventPayload) => void
  onRuntimeGoalContinuation?: (payload: RuntimeGoalContinuationPayload) => void
  onRuntimePlanUpdated?: (payload: RuntimePlanEventPayload) => void
  onGuidanceApplied?: (payload: RuntimeGuidanceAppliedPayload) => void
  onRuntimeTransportReplaced?: (payload: RuntimeTransportReplacedPayload) => void
}

export interface RuntimeConversationStreamHandlers {
  onMessageAction: (address: RuntimeTaskAddress, action: RuntimePaneMessageAction) => void
  onAssistantStart?: (address: RuntimeTaskAddress, turnId: string) => void
  onAssistantFirstToken?: (address: RuntimeTaskAddress, turnId: string) => void
  onAssistantResponseSize?: (
    address: RuntimeTaskAddress,
    turnId: string,
    responseSizeBytes: number
  ) => void
  onAssistantSettled?: (
    address: RuntimeTaskAddress,
    turnId: string,
    outcome: 'succeeded' | 'failed' | 'cancelled'
  ) => void
  onRefreshWorkLists?: (address: RuntimeTaskAddress) => void
  onContextUsageUpdated?: (address: RuntimeTaskAddress, usage: RuntimeContextUsage) => void
  onSubagentActivity?: (
    address: RuntimeTaskAddress,
    payload: RuntimeSubagentActivityPayload
  ) => void
  onRuntimeGoalUpdated?: (address: RuntimeTaskAddress, payload: RuntimeGoalEventPayload) => void
  onRuntimeGoalCleared?: (address: RuntimeTaskAddress, payload: RuntimeGoalEventPayload) => void
  onRuntimeSupervisorUpdated?: (
    address: RuntimeTaskAddress,
    payload: RuntimeSupervisorEventPayload
  ) => void
  onRuntimeGoalContinuation?: (
    address: RuntimeTaskAddress,
    payload: RuntimeGoalContinuationPayload
  ) => void
  onRuntimePlanUpdated?: (address: RuntimeTaskAddress, payload: RuntimePlanEventPayload) => void
  onGuidanceApplied?: (address: RuntimeTaskAddress, payload: RuntimeGuidanceAppliedPayload) => void
  onRuntimeTransportReplaced?: (payload: RuntimeTransportReplacedPayload) => void
}

export function createRuntimeConversationStreamHandlers(
  handlers: RuntimeConversationStreamHandlers
): ChatStreamHandlers {
  const taskHandlers = new Map<string, ChatStreamHandlers>()

  const resolve = (payload: { deviceId?: string; taskId?: string }): ChatStreamHandlers | null => {
    if (!payload.deviceId || !payload.taskId) {
      console.warn('[Wework] Dropped runtime event without task address', {
        deviceId: payload.deviceId ?? null,
        taskId: payload.taskId ?? null,
      })
      return null
    }
    const address = {
      deviceId: payload.deviceId,
      taskId: payload.taskId,
    }
    const key = `${address.deviceId}:${address.taskId}`
    const existing = taskHandlers.get(key)
    if (existing) return existing

    const created = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => handlers.onMessageAction(address, action),
      onAssistantStart: turnId => handlers.onAssistantStart?.(address, turnId),
      onAssistantFirstToken: turnId => handlers.onAssistantFirstToken?.(address, turnId),
      onAssistantResponseSize: (turnId, responseSizeBytes) =>
        handlers.onAssistantResponseSize?.(address, turnId, responseSizeBytes),
      onAssistantSettled: (turnId, outcome) =>
        handlers.onAssistantSettled?.(address, turnId, outcome),
      onRefreshWorkLists: () => handlers.onRefreshWorkLists?.(address),
      onContextUsageUpdated: usage => handlers.onContextUsageUpdated?.(address, usage),
      onSubagentActivity: payload => handlers.onSubagentActivity?.(address, payload),
      onRuntimeGoalUpdated: payload => handlers.onRuntimeGoalUpdated?.(address, payload),
      onRuntimeGoalCleared: payload => handlers.onRuntimeGoalCleared?.(address, payload),
      onRuntimeSupervisorUpdated: payload =>
        handlers.onRuntimeSupervisorUpdated?.(address, payload),
      onRuntimeGoalContinuation: payload => handlers.onRuntimeGoalContinuation?.(address, payload),
      onRuntimePlanUpdated: payload => handlers.onRuntimePlanUpdated?.(address, payload),
      onGuidanceApplied: payload => handlers.onGuidanceApplied?.(address, payload),
    })
    taskHandlers.set(key, created)
    return created
  }

  return {
    onChatStart: payload => resolve(payload)?.onChatStart?.(payload),
    onChatChunk: payload => resolve(payload)?.onChatChunk?.(payload),
    onChatDone: payload => resolve(payload)?.onChatDone?.(payload),
    onChatError: payload => resolve(payload)?.onChatError?.(payload),
    onBlockCreated: payload => resolve(payload)?.onBlockCreated?.(payload),
    onBlockUpdated: payload => resolve(payload)?.onBlockUpdated?.(payload),
    onSubagentActivity: payload => resolve(payload)?.onSubagentActivity?.(payload),
    onRuntimeGoalUpdated: payload => resolve(payload)?.onRuntimeGoalUpdated?.(payload),
    onRuntimeGoalCleared: payload => resolve(payload)?.onRuntimeGoalCleared?.(payload),
    onRuntimeSupervisorUpdated: payload => resolve(payload)?.onRuntimeSupervisorUpdated?.(payload),
    onRuntimeGoalContinuation: payload => resolve(payload)?.onRuntimeGoalContinuation?.(payload),
    onRuntimePlanUpdated: payload => resolve(payload)?.onRuntimePlanUpdated?.(payload),
    onGuidanceApplied: payload => resolve(payload)?.onGuidanceApplied?.(payload),
    onRuntimeTransportReplaced: payload => handlers.onRuntimeTransportReplaced?.(payload),
  }
}

export function createRuntimeTaskStreamHandlers(
  address: RuntimeTaskAddress,
  handlers: RuntimeTaskStreamHandlers
): ChatStreamHandlers {
  const streamedFileChanges = new Map<string, Map<string, TurnFileChangesSummary>>()
  const firstTokenSent = new Set<string>()

  const streamHandlers: ChatStreamHandlers = {
    scope: {
      deviceId: address.deviceId,
      taskId: address.taskId,
    },
    onChatStart: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      if (payload.runtimeGeneratedUserMessage) {
        handlers.onMessageAction({
          type: 'user_added',
          message: {
            id: payload.runtimeGeneratedUserMessage.id,
            taskId: address.taskId,
            role: 'user',
            content: payload.runtimeGeneratedUserMessage.message,
            status: 'done',
            source: payload.runtimeGeneratedUserMessage.source as MessageSource,
            createdAt: new Date(payload.runtimeGeneratedUserMessage.createdAt).toISOString(),
          },
        })
      }
      const identity = runtimeStreamTaskSubtaskIdentity(payload)
      if (!identity) {
        warnAndDropRuntimeStreamEvent('chat:start', address, payload)
        return
      }
      debugRuntimeStreamEvent('chat:start', address, payload, true)
      handlers.onAssistantStart?.(identity.subtaskId)
      handlers.onMessageAction({
        type: 'assistant_started',
        taskId: payload.taskId,
        subtaskId: identity.subtaskId,
        clientUserMessageId: payload.clientUserMessageId,
        shellType: payload.shellType,
      })
      handlers.onRefreshWorkLists?.()
    },
    onChatChunk: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const contextUsage = payload.result?.contextUsage
      const identity = runtimeStreamTaskSubtaskIdentity(payload)
      const reasoningChunk = getReasoningChunk(payload.result)
      if (!identity) {
        if (contextUsage && !payload.content && !reasoningChunk) {
          handlers.onContextUsageUpdated?.(contextUsage)
          return
        }
        warnAndDropRuntimeStreamEvent('chat:chunk', address, payload, {
          hasContent: Boolean(payload.content),
          hasReasoningChunk: Boolean(reasoningChunk),
        })
        return
      }
      const blocks = getResultBlocks(identity.subtaskId, payload.result)
      if (!payload.content && !reasoningChunk && (!blocks || blocks.length === 0)) {
        if (contextUsage) {
          handlers.onContextUsageUpdated?.(contextUsage)
          return
        }
        warnAndDropEmptyRuntimeChunk(address, payload, {
          reason: 'empty_chunk',
          resultKeys: isRecord(payload.result) ? Object.keys(payload.result) : [],
        })
        return
      }
      if (contextUsage) {
        handlers.onContextUsageUpdated?.(contextUsage)
      }
      if (payload.content || reasoningChunk) {
        if (!firstTokenSent.has(identity.subtaskId)) {
          firstTokenSent.add(identity.subtaskId)
          handlers.onAssistantFirstToken?.(identity.subtaskId)
        }
      }
      debugRuntimeStreamEvent('chat:chunk', address, payload, true, {
        hasContent: Boolean(payload.content),
        hasReasoningChunk: Boolean(reasoningChunk),
        blockCount: blocks?.length ?? 0,
      })
      handlers.onMessageAction({
        type: 'assistant_chunk',
        subtaskId: identity.subtaskId,
        itemId: payload.itemId,
        content: payload.content,
        contentMode: payload.contentMode,
        offset: payload.offset,
        reasoningChunk,
        blocks,
      })
    },
    onChatDone: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) {
        warnAndDropMismatchedRuntimeTerminalEvent('chat:done', address, payload)
        return
      }
      const identity = runtimeStreamTaskSubtaskIdentity(payload)
      if (!identity) {
        warnAndDropRuntimeStreamEvent('chat:done', address, payload)
        return
      }
      const blocks = getResultBlocks(identity.subtaskId, payload.result)
      const fileChanges =
        normalizeTurnFileChanges(payload.result.fileChanges) ??
        fileChangesFromBlocks(blocks) ??
        mergeTurnFileChanges([...(streamedFileChanges.get(identity.subtaskId)?.values() ?? [])])
      streamedFileChanges.delete(identity.subtaskId)
      debugRuntimeStreamEvent('chat:done', address, payload, true, {
        hasFileChanges: Boolean(fileChanges),
        blockCount: blocks?.length ?? 0,
      })
      logAcceptedRuntimeTerminalEvent('chat:done', address, payload, {
        hasFileChanges: Boolean(fileChanges),
        blockCount: blocks?.length ?? 0,
      })
      if (payload.result.contextUsage) {
        handlers.onContextUsageUpdated?.(payload.result.contextUsage)
      }
      handlers.onMessageAction({
        type: 'assistant_done',
        subtaskId: identity.subtaskId,
        turnId:
          typeof payload.result.turnId === 'string'
            ? payload.result.turnId
            : typeof payload.result.turn_id === 'string'
              ? payload.result.turn_id
              : undefined,
        ...(typeof payload.result.value === 'string' &&
          payload.result.value.trim() && { content: payload.result.value }),
        blocks,
        fileChanges,
      })
      const assistantText =
        typeof payload.result?.value === 'string' && payload.result.value.trim()
          ? payload.result.value
          : undefined
      if (assistantText) {
        handlers.onAssistantResponseSize?.(
          identity.subtaskId,
          new TextEncoder().encode(assistantText).byteLength
        )
      }
      handlers.onAssistantSettled?.(identity.subtaskId, 'succeeded')
      handlers.onRefreshWorkLists?.()
    },
    onChatError: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) {
        warnAndDropMismatchedRuntimeTerminalEvent('chat:error', address, payload)
        return
      }
      const identity = runtimeStreamTaskSubtaskIdentity(payload)
      if (!identity) {
        warnAndDropRuntimeStreamEvent('chat:error', address, payload, {
          errorType: payload.type,
        })
        return
      }
      debugRuntimeStreamEvent('chat:error', address, payload, true, {
        error: payload.error,
        errorType: payload.type,
      })
      logAcceptedRuntimeTerminalEvent('chat:error', address, payload, {
        errorType: payload.type ?? null,
      })
      const cancelled = isCancelledRuntimeError(payload)
      if (cancelled) {
        handlers.onMessageAction({
          type: 'assistant_cancelled',
          subtaskId: identity.subtaskId,
        })
      } else if (payload.shellType?.toLowerCase() === 'codex') {
        handlers.onMessageAction({
          type: 'assistant_error',
          subtaskId: identity.subtaskId,
          error: payload.error,
          errorType: payload.type,
        })
      } else {
        handlers.onMessageAction({
          type: 'assistant_error',
          subtaskId: identity.subtaskId,
          error: payload.error,
          errorType: payload.type,
        })
      }
      handlers.onAssistantSettled?.(identity.subtaskId, cancelled ? 'cancelled' : 'failed')
      streamedFileChanges.delete(identity.subtaskId)
      handlers.onRefreshWorkLists?.()
    },
    onBlockCreated: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const identity = runtimeStreamTaskSubtaskIdentity(payload)
      if (!identity) {
        warnAndDropRuntimeStreamEvent('block:created', address, payload, {
          rawBlockType: isRecord(payload.block) ? payload.block.type : null,
        })
        return
      }
      const block = normalizeChatBlock(identity.subtaskId, payload.block)
      debugRuntimeStreamEvent('block:created', address, payload, true, {
        rawBlockType: isRecord(payload.block) ? payload.block.type : null,
        normalizedBlockType: block?.type ?? null,
      })
      if (!block) return
      if (block.type === 'file_changes') {
        rememberStreamedFileChanges(
          streamedFileChanges,
          identity.subtaskId,
          block.id,
          block.fileChanges
        )
      }
      handlers.onMessageAction({
        type: 'block_created',
        subtaskId: identity.subtaskId,
        block,
        replaceAssistantTextItemId: payload.replacesItemId,
      })
      if (isStandaloneCompletedContextCompaction(identity.subtaskId, block)) {
        handlers.onMessageAction({
          type: 'assistant_done',
          subtaskId: identity.subtaskId,
        })
        handlers.onAssistantSettled?.(identity.subtaskId, 'succeeded')
        handlers.onRefreshWorkLists?.()
      }
    },
    onBlockUpdated: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const identity = runtimeStreamTaskSubtaskIdentity(payload)
      if (!identity) {
        warnAndDropRuntimeStreamEvent('block:updated', address, payload, {
          blockId: payload.blockId,
          status: payload.status ?? null,
        })
        return
      }
      debugRuntimeStreamEvent('block:updated', address, payload, true, {
        blockId: payload.blockId,
        status: payload.status ?? null,
        hasContent: payload.content !== undefined,
        hasToolInput: payload.toolInput !== undefined,
        hasToolOutput: payload.toolOutput !== undefined,
        hasToolOutputDelta: payload.toolOutputDelta !== undefined,
        hasToolOutputTruncated: payload.toolOutputTruncated !== undefined,
        hasRenderPayload: payload.renderPayload !== undefined,
        hasFileChanges: payload.fileChanges !== undefined,
      })
      const fileChanges = normalizeTurnFileChanges(payload.fileChanges)
      if (fileChanges) {
        rememberStreamedFileChanges(
          streamedFileChanges,
          identity.subtaskId,
          payload.blockId,
          fileChanges
        )
      }
      handlers.onMessageAction({
        type: 'block_updated',
        subtaskId: identity.subtaskId,
        blockId: payload.blockId,
        updates: {
          ...(payload.content !== undefined && { content: payload.content }),
          ...(payload.toolInput !== undefined && { toolInput: payload.toolInput }),
          ...(payload.toolOutput !== undefined && { toolOutput: payload.toolOutput }),
          ...(payload.toolOutputDelta !== undefined && {
            toolOutputDelta: payload.toolOutputDelta,
          }),
          ...(payload.toolOutputTruncated !== undefined && {
            toolOutputTruncated: payload.toolOutputTruncated,
          }),
          ...(payload.renderPayload !== undefined && {
            renderPayload: payload.renderPayload,
          }),
          ...(payload.fileChanges !== undefined && {
            fileChanges: normalizeTurnFileChanges(payload.fileChanges),
          }),
          ...(payload.status && { status: normalizeWorkbenchBlockStatus(payload.status) }),
        },
      })
    },
    onSubagentActivity: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      debugRuntimeStreamEvent('subagent:activity', address, payload, true, {
        agentPath: payload.agentPath,
        status: payload.status ?? null,
        kind: payload.kind ?? null,
      })
      handlers.onSubagentActivity?.(payload)
    },
    onRuntimeGoalUpdated: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      handlers.onRuntimeGoalUpdated?.(payload)
    },
    onRuntimeGoalCleared: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      handlers.onRuntimeGoalCleared?.(payload)
    },
    onRuntimeSupervisorUpdated: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      handlers.onRuntimeSupervisorUpdated?.(payload)
    },
    onRuntimeGoalContinuation: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      handlers.onRuntimeGoalContinuation?.(payload)
    },
    onRuntimePlanUpdated: payload => {
      const matched = isRuntimeTaskStreamPayload(address, payload)
      debugRuntimeStreamEvent('plan:updated', address, payload, matched, {
        threadId: payload.threadId ?? null,
        turnId: payload.turnId ?? null,
        stepCount: payload.plan.length,
      })
      if (import.meta.env.DEV) {
        console.info('[Wework] Runtime task plan scoped', {
          matched,
          currentTaskId: address.taskId,
          eventTaskId: payload.taskId ?? null,
          stepCount: payload.plan.length,
        })
      }
      if (!matched) return
      handlers.onRuntimePlanUpdated?.(payload)
    },
    onGuidanceApplied: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      handlers.onGuidanceApplied?.(payload)
    },
    onRuntimeTransportReplaced: payload => {
      handlers.onRuntimeTransportReplaced?.(payload)
    },
  }
  return streamHandlers
}

function isStandaloneCompletedContextCompaction(
  subtaskId: string,
  block: ProcessingBlock
): boolean {
  return isStandaloneContextCompactionSubtask(subtaskId) && isCompletedContextCompactionBlock(block)
}

function isStandaloneContextCompactionSubtask(subtaskId: string): boolean {
  return subtaskId.endsWith('-context-compact')
}

function isCompletedContextCompactionBlock(block: ProcessingBlock): boolean {
  if (block.type !== 'tool' || block.status !== 'done') return false
  return normalizeToolName(block.toolName) === 'contextcompaction'
}

function normalizeToolName(toolName: string): string {
  return toolName.replace(/[\s_-]+/g, '').toLowerCase()
}

export function runtimeMessagesToWorkbenchMessages(
  messages: NormalizedRuntimeMessage[]
): WorkbenchMessage[] {
  return messages.map(runtimeMessageToWorkbenchMessage)
}

export function runtimeTranscriptTurnsToConversationTurns(
  turns: RuntimeTranscriptTurn[]
): RuntimeConversationTurn[] {
  return turns.flatMap(turn => {
    if (typeof turn.id !== 'string' || !turn.id.trim() || !Array.isArray(turn.items)) return []
    const fallbackTimestamp = runtimeTurnFallbackTimestamp(turn)
    const items: RuntimeConversationItem[] = []
    for (const item of turn.items) {
      if (!item || typeof item.id !== 'string' || !item.id.trim()) continue
      switch (item.type) {
        case 'user_message': {
          const message = runtimeMessageToWorkbenchMessage(item.message)
          if (message.role === 'user') {
            items.push({
              id: item.id,
              type: 'user_message',
              message: { ...message, role: 'user' },
            })
          }
          break
        }
        case 'assistant_text': {
          if (typeof item.content === 'string') {
            items.push({
              id: item.id,
              type: 'assistant_text',
              content: stripCodexUiDirectives(item.content),
              createdAt: runtimeTimestampToIso(item.createdAt),
            })
          }
          break
        }
        case 'block': {
          const block = normalizeProcessingBlock(turn.id, item.block, 0, fallbackTimestamp)
          if (block) items.push({ id: item.id, type: 'block', block })
          break
        }
      }
    }
    const normalizedStatus = String(turn.runtimeStatus ?? turn.status ?? '').toLowerCase()
    const status: RuntimeConversationTurn['status'] =
      normalizedStatus === 'cancelled'
        ? 'cancelled'
        : normalizedStatus === 'failed'
          ? 'failed'
          : isRuntimeStreamingStatus(normalizedStatus)
            ? 'streaming'
            : 'done'
    return [
      {
        id: turn.id,
        clientUserMessageId: items.find(item => item.type === 'user_message')?.message.id,
        runtimeMessageIndex: typeof turn.messageIndex === 'number' ? turn.messageIndex : undefined,
        items,
        status,
        completedAt: turn.completedAt,
        error: turn.error ?? undefined,
        errorType: turn.errorType ?? undefined,
        stoppedNotice: turn.stoppedNotice,
        fileChanges: normalizeTurnFileChanges(turn.fileChanges),
        references: turn.references ?? undefined,
        memoryCitations: turn.memoryCitations ?? undefined,
      },
    ]
  })
}

export function findFileChangesBySubtaskId(
  messages: WorkbenchMessage[],
  subtaskId: string
): TurnFileChangesSummary | undefined {
  return messages.find(
    message => message.subtaskId === subtaskId && message.fileChanges !== undefined
  )?.fileChanges
}

export function runtimeAddressDebug(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? null,
  }
}

export function runtimeTranscriptDebug(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) {
    return { responseType: Array.isArray(response) ? 'array' : typeof response }
  }
  const messages = response.messages
  return {
    keys: Object.keys(response).slice(0, 20),
    success: response.success,
    error: response.error,
    runtime: response.runtime,
    hasMessages: 'messages' in response,
    messagesType: Array.isArray(messages) ? 'array' : typeof messages,
    messageCount: Array.isArray(messages) ? messages.length : null,
    turnNavigationCount: Array.isArray(response.turnNavigation)
      ? response.turnNavigation.length
      : null,
    rangeStart: response.rangeStart,
    rangeEnd: response.rangeEnd,
    hasMoreBefore: response.hasMoreBefore,
    beforeCursor: response.beforeCursor,
    hasMoreAfter: response.hasMoreAfter,
    afterCursor: response.afterCursor,
  }
}

function isRuntimeTaskStreamPayload(
  address: RuntimeTaskAddress,
  payload:
    | ChatStartPayload
    | ChatChunkPayload
    | ChatDonePayload
    | ChatErrorPayload
    | ChatBlockCreatedPayload
    | ChatBlockUpdatedPayload
    | RuntimeGoalEventPayload
    | RuntimeSubagentActivityPayload
): boolean {
  if (typeof payload.taskId !== 'string' || !payload.taskId.trim()) return false
  return (
    (!payload.deviceId || payload.deviceId === address.deviceId) &&
    payload.taskId === address.taskId
  )
}

function runtimeStreamTaskSubtaskIdentity(
  payload:
    | ChatStartPayload
    | ChatChunkPayload
    | ChatDonePayload
    | ChatErrorPayload
    | ChatBlockCreatedPayload
    | ChatBlockUpdatedPayload
    | RuntimeSubagentActivityPayload
): { taskId: string; subtaskId: string } | null {
  const taskId = payload.taskId
  if (typeof taskId !== 'string' || !taskId.trim()) return null

  const subtaskId = payload.subtaskId
  if (typeof subtaskId !== 'string' || !subtaskId.trim()) {
    return null
  }

  return { taskId, subtaskId }
}

function runtimeMessageToWorkbenchMessage(message: NormalizedRuntimeMessage): WorkbenchMessage {
  const role = message.role.toLowerCase() === 'user' ? 'user' : 'assistant'
  const clientUserMessageId =
    message.clientUserMessageId ?? message.client_user_message_id ?? undefined
  const subtaskId = runtimeMessageSubtaskId(message)
  const normalizedStatus = String(message.status ?? '').toLowerCase()
  const status: WorkbenchMessage['status'] =
    normalizedStatus === 'failed'
      ? 'failed'
      : isRuntimeStreamingStatus(normalizedStatus)
        ? 'streaming'
        : 'done'
  const runtimeStatus = normalizedStatus === 'cancelled' ? 'cancelled' : status
  const source =
    role === 'user' && message.source?.source === 'im'
      ? ({ ...message.source, source: 'im' } as MessageSource)
      : undefined
  const createdAt = message.createdAt ?? new Date().toISOString()
  const completedAt = message.completedAt ?? message.completed_at ?? undefined
  const stoppedNotice = message.stoppedNotice ?? message.stopped_notice ?? undefined
  const runtimeMessageIndex =
    typeof message.messageIndex === 'number'
      ? message.messageIndex
      : typeof message.message_index === 'number'
        ? message.message_index
        : undefined
  const messageCreatedAtMs = getBlockTimestamp(createdAt)
  warnInvalidRuntimeTranscriptIdentity(message, role, status, subtaskId)
  const blocks =
    typeof subtaskId === 'string'
      ? normalizeProcessingBlocks(subtaskId, message.blocks, messageCreatedAtMs)
      : []
  const contentTruncated = hasTruncatedRuntimeContent(message)
  const content =
    role === 'assistant'
      ? stripCodexUiDirectives(message.content)
      : combineRuntimeUserMessagePresentation(
          message.content,
          message.presentationReferences ?? message.presentation_references
        )
  return {
    id: role === 'user' && clientUserMessageId ? clientUserMessageId : message.id,
    role,
    subtaskId,
    turnId: message.turnId ?? message.turn_id ?? undefined,
    content,
    contentTruncated: contentTruncated || undefined,
    contentOriginalChars: contentTruncated ? runtimeMessageOriginalChars(message) : undefined,
    runtimeMessageIndex,
    status,
    runtimeStatus,
    error: message.error ?? undefined,
    errorType: message.errorType ?? message.error_type ?? undefined,
    source,
    attachments: message.attachments,
    runtimeGoalRequest: normalizeRuntimeGoalRequest(message),
    blocks: blocks.length > 0 ? blocks : undefined,
    fileChanges: normalizeTurnFileChanges(message.fileChanges ?? message.file_changes),
    references: normalizeRuntimeReferences(message.references),
    memoryCitations: normalizeRuntimeMemoryCitations(message),
    createdAt,
    completedAt,
    stoppedNotice,
  }
}

function combineRuntimeUserMessagePresentation(
  content: string,
  references: RuntimeMessagePresentationReference[] | null | undefined
): string {
  if (!references?.length) return content

  const orderedReferences = [...references].sort((left, right) => left.start - right.start)
  const parts: string[] = []
  let offset = 0
  for (const reference of orderedReferences) {
    if (
      !Number.isInteger(reference.start) ||
      !Number.isInteger(reference.end) ||
      reference.start < offset ||
      reference.end <= reference.start ||
      reference.end > content.length ||
      !reference.href
    ) {
      continue
    }
    parts.push(content.slice(offset, reference.start))
    parts.push(`[${content.slice(reference.start, reference.end)}](${reference.href})`)
    offset = reference.end
  }
  if (offset === 0) return content
  parts.push(content.slice(offset))
  return parts.join('')
}

function hasTruncatedRuntimeContent(message: NormalizedRuntimeMessage): boolean {
  if (message.contentTruncated !== true && message.content_truncated !== true) return false

  const originalChars = runtimeMessageOriginalChars(message)
  return (
    originalChars !== undefined &&
    originalChars > RUNTIME_MESSAGE_CONTENT_TRUNCATION_THRESHOLD_CHARS &&
    originalChars > runtimeContentCharacterCount(message.content)
  )
}

function runtimeMessageOriginalChars(message: NormalizedRuntimeMessage): number | undefined {
  const originalChars =
    typeof message.contentOriginalChars === 'number'
      ? message.contentOriginalChars
      : typeof message.content_original_chars === 'number'
        ? message.content_original_chars
        : undefined

  return originalChars !== undefined && Number.isFinite(originalChars) && originalChars >= 0
    ? originalChars
    : undefined
}

function runtimeContentCharacterCount(content: string): number {
  return Array.from(content).length
}

function runtimeTimestampToIso(value: string | number | null | undefined): string {
  const timestamp = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString()
}

function runtimeTurnFallbackTimestamp(turn: RuntimeTranscriptTurn): number | undefined {
  for (const item of turn.items) {
    const value =
      item.type === 'user_message'
        ? item.message.createdAt
        : item.type === 'assistant_text'
          ? item.createdAt
          : (item.block.createdAt ?? item.block.created_at ?? item.block.timestamp)
    const timestamp = typeof value === 'number' ? value : Date.parse(value ?? '')
    if (Number.isFinite(timestamp)) return timestamp
  }
  return undefined
}

function warnAndDropRuntimeStreamEvent(
  event: string,
  address: RuntimeTaskAddress,
  payload: { taskId?: string; deviceId?: string; subtaskId?: string },
  details: Record<string, unknown> = {}
): void {
  console.warn('[Wework] Dropped runtime stream event without task identity', {
    event,
    address: runtimeAddressDebug(address),
    taskId: payload.taskId,
    deviceId: payload.deviceId,
    subtaskId: payload.subtaskId,
    ...details,
  })
}

function warnAndDropMismatchedRuntimeTerminalEvent(
  event: 'chat:done' | 'chat:error',
  address: RuntimeTaskAddress,
  payload: { taskId?: string; deviceId?: string; subtaskId?: string }
): void {
  console.warn('[Wework] Dropped mismatched runtime terminal event', {
    event,
    currentRuntimeTask: runtimeAddressDebug(address),
    payloadTaskId: payload.taskId ?? null,
    payloadDeviceId: payload.deviceId ?? null,
    payloadSubtaskId: payload.subtaskId ?? null,
  })
}

function logAcceptedRuntimeTerminalEvent(
  event: 'chat:done' | 'chat:error',
  address: RuntimeTaskAddress,
  payload: { taskId?: string; deviceId?: string; subtaskId?: string },
  details: Record<string, unknown>
): void {
  console.info('[Wework] Runtime terminal event accepted', {
    event,
    currentRuntimeTask: runtimeAddressDebug(address),
    payloadTaskId: payload.taskId ?? null,
    payloadDeviceId: payload.deviceId ?? null,
    payloadSubtaskId: payload.subtaskId ?? null,
    ...details,
  })
}

function warnAndDropEmptyRuntimeChunk(
  address: RuntimeTaskAddress,
  payload: ChatChunkPayload,
  details: Record<string, unknown> = {}
): void {
  console.warn('[Wework] Dropped empty runtime stream chunk', {
    event: 'chat:chunk',
    address: runtimeAddressDebug(address),
    taskId: payload.taskId,
    deviceId: payload.deviceId,
    subtaskId: payload.subtaskId,
    hasContent: Boolean(payload.content),
    hasReasoningChunk: Boolean(getReasoningChunk(payload.result)),
    ...details,
  })
}

function normalizeRuntimeGoalRequest(message: NormalizedRuntimeMessage): boolean | undefined {
  return message.runtimeGoalRequest === true || message.runtime_goal_request === true
    ? true
    : undefined
}

function runtimeMessageSubtaskId(message: NormalizedRuntimeMessage): string | undefined {
  const subtaskId = message.subtaskId
  if (typeof subtaskId === 'number') return String(subtaskId)
  return typeof subtaskId === 'string' && subtaskId.trim() ? subtaskId : undefined
}

function warnInvalidRuntimeTranscriptIdentity(
  message: NormalizedRuntimeMessage,
  role: WorkbenchMessage['role'],
  status: WorkbenchMessage['status'],
  subtaskId: string | undefined
): void {
  const hasBlocks = Array.isArray(message.blocks) && message.blocks.length > 0
  const needsSubtaskId = role === 'assistant' && (status === 'streaming' || hasBlocks)
  if (!needsSubtaskId || typeof subtaskId === 'string') return

  console.warn('[Wework] Runtime transcript message missing valid subtask identity', {
    messageId: message.id,
    role,
    status,
    subtaskId: message.subtaskId,
    blockCount: hasBlocks ? message.blocks?.length : 0,
  })
}

function normalizeRuntimeReferences(
  references: NormalizedRuntimeMessage['references']
): WorkbenchMessage['references'] {
  if (!Array.isArray(references)) return undefined
  const normalized = references.filter(
    reference => reference && typeof reference.path === 'string' && reference.path.trim()
  )
  return normalized.length > 0 ? normalized : undefined
}

function normalizeRuntimeMemoryCitations(
  message: NormalizedRuntimeMessage
): WorkbenchMessage['memoryCitations'] {
  const citations: NonNullable<WorkbenchMessage['memoryCitations']> = []
  const addCitation = (value: unknown) => {
    if (isRecord(value) && Array.isArray(value.entries)) {
      citations.push(value as NonNullable<WorkbenchMessage['memoryCitations']>[number])
    }
  }

  if (Array.isArray(message.memoryCitations)) {
    message.memoryCitations.forEach(addCitation)
  }
  if (Array.isArray(message.memory_citations)) {
    message.memory_citations.forEach(addCitation)
  }
  addCitation(message.memoryCitation)
  addCitation(message.memory_citation)

  return citations.length > 0 ? citations : undefined
}

function isRuntimeStreamingStatus(status: string): boolean {
  return (
    status === 'streaming' ||
    status === 'running' ||
    status === 'inprogress' ||
    status === 'in_progress' ||
    status === 'busy' ||
    status === 'pending'
  )
}

function isCancelledRuntimeError(payload: ChatErrorPayload): boolean {
  const error = payload.error.trim().toLowerCase()
  const type = payload.type?.trim().toLowerCase()
  return (
    error === 'interrupted' ||
    error === 'cancelled' ||
    error === 'canceled' ||
    error === 'aborted' ||
    type === 'interrupted' ||
    type === 'cancelled' ||
    type === 'canceled' ||
    type === 'aborted'
  )
}

function normalizeChatBlock(subtaskId: string, block: ChatBlock): ProcessingBlock | null {
  return normalizeProcessingBlock(subtaskId, block, 0)
}

function normalizeToolRenderPayload(block: Record<string, unknown>): unknown {
  const payload = block.renderPayload ?? block.render_payload
  const response = block.requestUserInputResponse ?? block.request_user_input_response
  if (!isRecord(payload) || response === undefined) return payload
  if (payload.kind !== 'request_user_input') return payload
  return {
    ...payload,
    response,
  }
}

function normalizeProcessingBlock(
  subtaskId: string,
  block: unknown,
  index: number,
  fallbackTimestamp?: number
): ProcessingBlock | null {
  if (!isRecord(block)) return null

  const timestamp = getBlockTimestamp(
    block.timestamp ?? block.created_at ?? block.createdAt,
    fallbackTimestamp
  )
  const status = normalizeWorkbenchBlockStatus(
    typeof block.status === 'string' ? block.status : undefined
  )

  if (block.type === 'tool') {
    const id =
      typeof block.id === 'string'
        ? block.id
        : typeof block.tool_use_id === 'string'
          ? block.tool_use_id
          : typeof block.toolUseId === 'string'
            ? block.toolUseId
            : null
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index)
    return {
      id,
      subtaskId,
      type: 'tool',
      toolName:
        typeof block.toolName === 'string'
          ? block.toolName
          : typeof block.tool_name === 'string'
            ? block.tool_name
            : 'unknown',
      toolInput: isRecord(block.toolInput)
        ? block.toolInput
        : isRecord(block.tool_input)
          ? block.tool_input
          : undefined,
      toolOutput: block.toolOutput ?? block.tool_output,
      toolOutputTruncated:
        typeof block.toolOutputTruncated === 'boolean'
          ? block.toolOutputTruncated
          : typeof block.tool_output_truncated === 'boolean'
            ? block.tool_output_truncated
            : undefined,
      toolOutputOriginalBytes:
        typeof block.toolOutputOriginalBytes === 'number'
          ? block.toolOutputOriginalBytes
          : typeof block.tool_output_original_bytes === 'number'
            ? block.tool_output_original_bytes
            : undefined,
      renderPayload: normalizeToolRenderPayload(block),
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'image_generation_call') {
    const id = typeof block.id === 'string' ? block.id : null
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index)
    return {
      id,
      subtaskId,
      type: 'tool',
      toolName: 'image_generation',
      renderPayload: {
        kind: 'image_generation',
        ...(typeof block.result === 'string' && { imageBase64: block.result }),
        ...(typeof block.revised_prompt === 'string' && { revisedPrompt: block.revised_prompt }),
        ...(typeof block.saved_path === 'string' && { savedPath: block.saved_path }),
      },
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'thinking') {
    const id = typeof block.id === 'string' ? block.id : null
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index)
    return {
      id,
      subtaskId,
      type: 'thinking',
      content: typeof block.content === 'string' ? block.content : '',
      contentTruncated:
        typeof block.contentTruncated === 'boolean'
          ? block.contentTruncated
          : typeof block.content_truncated === 'boolean'
            ? block.content_truncated
            : undefined,
      contentOriginalChars:
        typeof block.contentOriginalChars === 'number'
          ? block.contentOriginalChars
          : typeof block.content_original_chars === 'number'
            ? block.content_original_chars
            : undefined,
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'text') {
    const id = typeof block.id === 'string' ? block.id : null
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index)
    const content =
      typeof block.content === 'string'
        ? block.content
        : typeof block.text === 'string'
          ? block.text
          : ''
    return {
      id,
      subtaskId,
      type: 'text',
      content,
      contentTruncated:
        typeof block.contentTruncated === 'boolean'
          ? block.contentTruncated
          : typeof block.content_truncated === 'boolean'
            ? block.content_truncated
            : undefined,
      contentOriginalChars:
        typeof block.contentOriginalChars === 'number'
          ? block.contentOriginalChars
          : typeof block.content_original_chars === 'number'
            ? block.content_original_chars
            : undefined,
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'plan') {
    const id = typeof block.id === 'string' ? block.id : null
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index)
    const content =
      typeof block.content === 'string'
        ? block.content
        : typeof block.text === 'string'
          ? block.text
          : ''
    return {
      id,
      subtaskId,
      type: 'plan',
      content,
      contentTruncated:
        typeof block.contentTruncated === 'boolean'
          ? block.contentTruncated
          : typeof block.content_truncated === 'boolean'
            ? block.content_truncated
            : undefined,
      contentOriginalChars:
        typeof block.contentOriginalChars === 'number'
          ? block.contentOriginalChars
          : typeof block.content_original_chars === 'number'
            ? block.content_original_chars
            : undefined,
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'file_changes') {
    const fileChanges = normalizeTurnFileChanges(block.fileChanges ?? block.file_changes)
    if (!fileChanges) return null
    const id = typeof block.id === 'string' ? block.id : null
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index)
    return {
      id,
      subtaskId,
      type: 'file_changes',
      fileChanges,
      status,
      createdAt: timestamp,
    }
  }

  console.warn('[Wework] Dropped runtime block with unsupported type', {
    subtaskId,
    index,
    blockType: block.type,
    blockId: block.id,
    blockKeys: Object.keys(block).sort(),
  })
  return null
}

function warnAndDropRuntimeTranscriptBlock(
  subtaskId: string,
  block: Record<string, unknown>,
  index: number
): null {
  console.warn('[Wework] Dropped runtime transcript block without block identity', {
    subtaskId,
    index,
    blockType: block.type,
    blockId: block.id,
    toolUseId: block.tool_use_id,
  })
  return null
}

function normalizeProcessingBlocks(
  subtaskId: string,
  blocks?: unknown[],
  fallbackTimestamp?: number
): ProcessingBlock[] {
  if (!blocks) return []

  return blocks.flatMap((block, index) => {
    const normalized = normalizeProcessingBlock(subtaskId, block, index, fallbackTimestamp)
    return normalized ? [normalized] : []
  })
}

function getResultBlocks(subtaskId: string, result: unknown): ProcessingBlock[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.blocks)) return undefined
  const blocks = normalizeProcessingBlocks(subtaskId, result.blocks)
  return blocks.length > 0 ? blocks : undefined
}

function fileChangesFromBlocks(
  blocks: ProcessingBlock[] | undefined
): TurnFileChangesSummary | undefined {
  return mergeTurnFileChanges(
    (blocks ?? []).flatMap(block => (block.type === 'file_changes' ? [block.fileChanges] : []))
  )
}

function rememberStreamedFileChanges(
  summaries: Map<string, Map<string, TurnFileChangesSummary>>,
  subtaskId: string,
  blockId: string,
  fileChanges: TurnFileChangesSummary
) {
  let blocks = summaries.get(subtaskId)
  if (!blocks) {
    blocks = new Map()
    summaries.set(subtaskId, blocks)
  }
  blocks.set(blockId, fileChanges)
}

function getReasoningChunk(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  return typeof result.reasoningChunk === 'string' ? result.reasoningChunk : undefined
}

function getBlockTimestamp(value: unknown, fallbackTimestamp = Date.now()): number {
  if (typeof value === 'string' && value.trim()) {
    const numericValue = Number(value)
    if (Number.isFinite(numericValue)) {
      return getBlockTimestamp(numericValue, fallbackTimestamp)
    }

    const parsed = new Date(value).getTime()
    return Number.isFinite(parsed) ? parsed : fallbackTimestamp
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) return fallbackTimestamp

  if (value > 1_000_000_000_000) return value
  if (value > 1_000_000_000) return value * 1000
  return fallbackTimestamp
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type RuntimeDebugWindow = Window & { __WEWORK_RUNTIME_DEBUG__?: boolean }

function isRuntimeWorkDebugEnabled(): boolean {
  return (
    ((window as RuntimeDebugWindow).__WEWORK_RUNTIME_DEBUG__ ?? false) ||
    import.meta.env.VITE_WEWORK_RUNTIME_DEBUG === '1'
  )
}

function debugRuntimeStreamEvent(
  label: string,
  address: RuntimeTaskAddress,
  payload: { taskId?: string; deviceId?: string; subtaskId?: string },
  matched: boolean,
  details: Record<string, unknown> = {}
) {
  if (!isRuntimeWorkDebugEnabled()) return
  console.info(`[Wework runtime] ${label}`, {
    matched,
    currentRuntimeTask: runtimeAddressDebug(address),
    payloadDeviceId: payload.deviceId ?? null,
    payloadTaskId: payload.taskId ?? null,
    payloadSubtaskId: payload.subtaskId ?? null,
    ...details,
  })
}
