import type { ChatStreamHandlers } from '@/stream/chatStream'
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
  RuntimeSubagentActivityPayload,
  NormalizedRuntimeMessage,
  RuntimeTaskAddress,
  TurnFileChangesSummary,
} from '@/types/api'
import type { MessageSource, ProcessingBlock, WorkbenchMessage } from '@/types/workbench'
import { stripCodexUiDirectives } from '@/lib/codex-directives'
import { normalizeTurnFileChanges } from './turnFileChanges'
import { normalizeWorkbenchBlockStatus, type WorkbenchMessageAction } from '@wegent/chat-core'

export type RuntimePaneMessageAction = WorkbenchMessageAction<Attachment, TurnFileChangesSummary>

export interface RuntimeTaskStreamHandlers {
  onMessageAction: (action: RuntimePaneMessageAction) => void
  onAssistantStart?: () => void
  onAssistantSettled?: () => void
  onRefreshWorkLists?: () => void
  onContextUsageUpdated?: (usage: RuntimeContextUsage) => void
  onSubagentActivity?: (payload: RuntimeSubagentActivityPayload) => void
  onRuntimeGoalUpdated?: (payload: RuntimeGoalEventPayload) => void
  onRuntimeGoalCleared?: (payload: RuntimeGoalEventPayload) => void
  onRuntimeGoalContinuation?: (payload: RuntimeGoalContinuationPayload) => void
  onRuntimePlanUpdated?: (payload: RuntimePlanEventPayload) => void
  onGuidanceApplied?: (payload: RuntimeGuidanceAppliedPayload) => void
}

export function createRuntimeTaskStreamHandlers(
  address: RuntimeTaskAddress,
  handlers: RuntimeTaskStreamHandlers
): ChatStreamHandlers {
  return {
    scope: {
      deviceId: address.deviceId,
      taskId: address.taskId,
    },
    onChatStart: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const identity = runtimeStreamTaskSubtaskIdentity(payload)
      if (!identity) {
        warnAndDropRuntimeStreamEvent('chat:start', address, payload)
        return
      }
      debugRuntimeStreamEvent('chat:start', address, payload, true)
      handlers.onAssistantStart?.()
      handlers.onMessageAction({
        type: 'assistant_started',
        taskId: payload.taskId,
        subtaskId: identity.subtaskId,
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
      debugRuntimeStreamEvent('chat:chunk', address, payload, true, {
        hasContent: Boolean(payload.content),
        hasReasoningChunk: Boolean(reasoningChunk),
        blockCount: blocks?.length ?? 0,
      })
      handlers.onMessageAction({
        type: 'assistant_chunk',
        subtaskId: identity.subtaskId,
        content: payload.content,
        offset: payload.offset,
        reasoningChunk,
        blocks,
      })
    },
    onChatDone: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const identity = runtimeStreamTaskSubtaskIdentity(payload)
      if (!identity) {
        warnAndDropRuntimeStreamEvent('chat:done', address, payload)
        return
      }
      debugRuntimeStreamEvent('chat:done', address, payload, true, {
        hasFileChanges: Boolean(normalizeTurnFileChanges(payload.result.fileChanges)),
        blockCount: getResultBlocks(identity.subtaskId, payload.result)?.length ?? 0,
      })
      handlers.onAssistantSettled?.()
      if (payload.result.contextUsage) {
        handlers.onContextUsageUpdated?.(payload.result.contextUsage)
      }
      handlers.onMessageAction({
        type: 'assistant_done',
        subtaskId: identity.subtaskId,
        content: doneContent(payload.result),
        blocks: getResultBlocks(identity.subtaskId, payload.result),
        fileChanges: normalizeTurnFileChanges(payload.result.fileChanges),
      })
      handlers.onRefreshWorkLists?.()
    },
    onChatError: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
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
      handlers.onAssistantSettled?.()
      if (isCancelledRuntimeError(payload)) {
        handlers.onMessageAction({
          type: 'assistant_cancelled',
          subtaskId: identity.subtaskId,
        })
      } else {
        handlers.onMessageAction({
          type: 'assistant_error',
          subtaskId: identity.subtaskId,
          error: payload.error,
          errorType: payload.type,
        })
      }
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
      handlers.onMessageAction({
        type: 'block_created',
        subtaskId: identity.subtaskId,
        block,
      })
      if (isStandaloneCompletedContextCompaction(identity.subtaskId, block)) {
        handlers.onMessageAction({
          type: 'assistant_done',
          subtaskId: identity.subtaskId,
          content: '',
        })
        handlers.onAssistantSettled?.()
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
  }
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

export function findFileChangesBySubtaskId(
  messages: WorkbenchMessage[],
  subtaskId: string
): TurnFileChangesSummary | undefined {
  return messages.find(message => message.subtaskId === subtaskId)?.fileChanges
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
  return {
    id: message.id,
    role,
    subtaskId,
    content: role === 'assistant' ? stripCodexUiDirectives(message.content) : message.content,
    contentTruncated: contentTruncated || undefined,
    contentOriginalChars: contentTruncated ? runtimeMessageOriginalChars(message) : undefined,
    runtimeMessageIndex,
    status,
    runtimeStatus,
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

function hasTruncatedRuntimeContent(message: NormalizedRuntimeMessage): boolean {
  if (message.contentTruncated !== true && message.content_truncated !== true) return false

  const originalChars = runtimeMessageOriginalChars(message)
  return (
    originalChars !== undefined && originalChars > runtimeContentCharacterCount(message.content)
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
  return typeof message.subtaskId === 'string' && message.subtaskId.trim()
    ? message.subtaskId
    : undefined
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
    status === 'active' ||
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

function doneContent(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  if (typeof result.value !== 'string') return undefined
  const content = stripCodexUiDirectives(result.value)
  return content.length > 0 ? content : undefined
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
  console.debug(`[Wework runtime] ${label}`, {
    matched,
    currentRuntimeTask: runtimeAddressDebug(address),
    payloadDeviceId: payload.deviceId ?? null,
    payloadTaskId: payload.taskId ?? null,
    payloadSubtaskId: payload.subtaskId ?? null,
    ...details,
  })
}
