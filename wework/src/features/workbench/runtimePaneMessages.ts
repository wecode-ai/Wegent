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
  RuntimeSubagentActivityPayload,
  NormalizedRuntimeMessage,
  RuntimeTaskAddress,
  TurnFileChangesSummary,
} from '@/types/api'
import type { MessageSource, ProcessingBlock, WorkbenchMessage } from '@/types/workbench'
import { normalizeTurnFileChanges } from './turnFileChanges'
import { normalizeWorkbenchBlockStatus, type WorkbenchMessageAction } from '@wegent/chat-core'

const RUNTIME_BLOCK_TURN_ID_OFFSET = 1_000_000_000

export type RuntimePaneMessageAction = WorkbenchMessageAction<Attachment, TurnFileChangesSummary>

export interface RuntimeTaskStreamHandlers {
  onMessageAction: (action: RuntimePaneMessageAction) => void
  onAssistantStart?: () => void
  onAssistantSettled?: () => void
  onRefreshWorkLists?: () => void
  onSubagentActivity?: (payload: RuntimeSubagentActivityPayload) => void
}

export function createRuntimeTaskStreamHandlers(
  address: RuntimeTaskAddress,
  handlers: RuntimeTaskStreamHandlers
): ChatStreamHandlers {
  return {
    onChatStart: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const messageId = runtimeStreamMessageId(payload)
      debugRuntimeStreamEvent('chat:start', address, payload, true)
      handlers.onAssistantStart?.()
      handlers.onMessageAction({
        type: 'assistant_started',
        messageId,
        taskId: payload.task_id,
        turnId: payload.subtask_id,
        shellType: payload.shell_type,
      })
      handlers.onRefreshWorkLists?.()
    },
    onChatChunk: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const messageId = runtimeStreamMessageId(payload)
      debugRuntimeStreamEvent('chat:chunk', address, payload, true, {
        hasContent: Boolean(payload.content),
        hasReasoningChunk: Boolean(getReasoningChunk(payload.result)),
        blockCount: getResultBlocks(payload.subtask_id, payload.result)?.length ?? 0,
      })
      handlers.onMessageAction({
        type: 'assistant_chunk',
        messageId,
        turnId: payload.subtask_id,
        content: payload.content,
        reasoningChunk: getReasoningChunk(payload.result),
        blocks: getResultBlocks(payload.subtask_id, payload.result),
      })
    },
    onChatDone: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const messageId = runtimeStreamMessageId(payload)
      debugRuntimeStreamEvent('chat:done', address, payload, true, {
        hasFileChanges: Boolean(normalizeTurnFileChanges(payload.result.file_changes)),
        blockCount: getResultBlocks(payload.subtask_id, payload.result)?.length ?? 0,
      })
      handlers.onAssistantSettled?.()
      handlers.onMessageAction({
        type: 'assistant_done',
        messageId,
        turnId: payload.subtask_id,
        content: typeof payload.result.value === 'string' ? payload.result.value : undefined,
        blocks: getResultBlocks(payload.subtask_id, payload.result),
        fileChanges: normalizeTurnFileChanges(payload.result.file_changes),
      })
      handlers.onRefreshWorkLists?.()
    },
    onChatError: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const messageId = runtimeStreamMessageId(payload)
      debugRuntimeStreamEvent('chat:error', address, payload, true, {
        error: payload.error,
        errorType: payload.type,
      })
      handlers.onAssistantSettled?.()
      handlers.onMessageAction({
        type: 'assistant_error',
        messageId,
        turnId: payload.subtask_id,
        error: payload.error,
        errorType: payload.type,
      })
      handlers.onRefreshWorkLists?.()
    },
    onBlockCreated: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const messageId = runtimeStreamMessageId(payload)
      const block = normalizeChatBlock(payload.subtask_id, payload.block)
      debugRuntimeStreamEvent('block:created', address, payload, true, {
        rawBlockType: isRecord(payload.block) ? payload.block.type : null,
        normalizedBlockType: block?.type ?? null,
      })
      if (!block) return
      handlers.onMessageAction({
        type: 'block_created',
        messageId,
        turnId: payload.subtask_id,
        block,
      })
    },
    onBlockUpdated: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      const messageId = runtimeStreamMessageId(payload)
      debugRuntimeStreamEvent('block:updated', address, payload, true, {
        blockId: payload.block_id,
        status: payload.status ?? null,
        hasContent: payload.content !== undefined,
        hasToolInput: payload.tool_input !== undefined,
        hasToolOutput: payload.tool_output !== undefined,
      })
      handlers.onMessageAction({
        type: 'block_updated',
        messageId,
        turnId: payload.subtask_id,
        blockId: payload.block_id,
        updates: {
          ...(payload.content !== undefined && { content: payload.content }),
          ...(payload.tool_input !== undefined && { toolInput: payload.tool_input }),
          ...(payload.tool_output !== undefined && { toolOutput: payload.tool_output }),
          ...(payload.status && { status: normalizeWorkbenchBlockStatus(payload.status) }),
        },
      })
    },
    onSubagentActivity: payload => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return
      debugRuntimeStreamEvent('subagent:activity', address, payload, true, {
        agentPath: payload.agent_path,
        status: payload.status ?? null,
        kind: payload.kind ?? null,
      })
      handlers.onSubagentActivity?.(payload)
    },
  }
}

export function runtimeMessagesToWorkbenchMessages(
  messages: NormalizedRuntimeMessage[]
): WorkbenchMessage[] {
  return messages.map(runtimeMessageToWorkbenchMessage)
}

export function findFileChangesByTurnId(
  messages: WorkbenchMessage[],
  turnId: number
): TurnFileChangesSummary | undefined {
  return messages.find(message => message.turnId === turnId)?.fileChanges
}

export function findActiveAssistantMessage(
  messages: WorkbenchMessage[]
): WorkbenchMessage | undefined {
  return [...messages]
    .reverse()
    .find(message => message.role === 'assistant' && message.status === 'streaming')
}

export function runtimeAddressDebug(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    localTaskId: address.localTaskId,
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
    | RuntimeSubagentActivityPayload
): boolean {
  if (!payload.local_task_id) return false
  return (
    (!payload.device_id || payload.device_id === address.deviceId) &&
    payload.local_task_id === address.localTaskId
  )
}

function runtimeStreamMessageId(
  payload:
    | ChatStartPayload
    | ChatChunkPayload
    | ChatDonePayload
    | ChatErrorPayload
    | ChatBlockCreatedPayload
    | ChatBlockUpdatedPayload
    | RuntimeSubagentActivityPayload
): string {
  const rawMessageId = typeof payload.message_id === 'number' ? payload.message_id : null
  if (rawMessageId !== null) {
    return `${payload.local_task_id ?? 'runtime'}:message:${rawMessageId}`
  }
  return `${payload.local_task_id ?? 'runtime'}:message:${payload.task_id ?? 0}:${payload.subtask_id}`
}

function runtimeMessageToWorkbenchMessage(message: NormalizedRuntimeMessage): WorkbenchMessage {
  const role = message.role.toLowerCase() === 'user' ? 'user' : 'assistant'
  const turnId =
    typeof message.turnId === 'number'
      ? message.turnId
      : typeof message.subtask_id === 'number'
        ? message.subtask_id
        : undefined
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
  const blocks = normalizeProcessingBlocks(
    getRuntimeMessageBlockTurnId(message, turnId),
    message.blocks,
    messageCreatedAtMs
  )
  return {
    id: message.id,
    role,
    turnId,
    content: message.content,
    runtimeMessageIndex,
    status,
    runtimeStatus,
    source,
    attachments: message.attachments,
    blocks: blocks.length > 0 ? blocks : undefined,
    fileChanges: normalizeTurnFileChanges(message.fileChanges ?? message.file_changes),
    references: normalizeRuntimeReferences(message.references),
    memoryCitations: normalizeRuntimeMemoryCitations(message),
    contextEvents: normalizeRuntimeContextEvents(message),
    createdAt,
    completedAt,
    stoppedNotice,
  }
}

function getRuntimeMessageBlockTurnId(message: NormalizedRuntimeMessage, turnId?: number): number {
  if (typeof turnId === 'number') return turnId

  let hash = 0
  for (let index = 0; index < message.id.length; index += 1) {
    hash = (hash * 31 + message.id.charCodeAt(index)) % 1_000_000
  }

  return RUNTIME_BLOCK_TURN_ID_OFFSET + hash
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

function normalizeRuntimeContextEvents(
  message: NormalizedRuntimeMessage
): WorkbenchMessage['contextEvents'] {
  const events = [...(message.contextEvents ?? []), ...(message.context_events ?? [])].filter(
    event => event && typeof event.id === 'string' && typeof event.type === 'string'
  )
  return events.length > 0 ? events : undefined
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

function normalizeChatBlock(turnId: number, block: ChatBlock): ProcessingBlock | null {
  return normalizeProcessingBlock(turnId, block, 0)
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
  turnId: number,
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
          : `tool-${turnId}-${index}`
    return {
      id,
      turnId,
      type: 'tool',
      toolName: typeof block.tool_name === 'string' ? block.tool_name : 'unknown',
      toolInput: isRecord(block.tool_input) ? block.tool_input : undefined,
      toolOutput: block.tool_output,
      renderPayload: normalizeToolRenderPayload(block),
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'thinking') {
    const id = typeof block.id === 'string' ? block.id : `thinking-${turnId}-${index}`
    return {
      id,
      turnId,
      type: 'thinking',
      content: typeof block.content === 'string' ? block.content : '',
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'text') {
    const id = typeof block.id === 'string' ? block.id : `text-${turnId}-${index}`
    const content =
      typeof block.content === 'string'
        ? block.content
        : typeof block.text === 'string'
          ? block.text
          : ''
    return {
      id,
      turnId,
      type: 'text',
      content,
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'file_changes') {
    const fileChanges = normalizeTurnFileChanges(block.fileChanges ?? block.file_changes)
    if (!fileChanges) return null
    const id = typeof block.id === 'string' ? block.id : `file-changes-${turnId}-${index}`
    return {
      id,
      turnId,
      type: 'file_changes',
      fileChanges,
      status,
      createdAt: timestamp,
    }
  }

  return null
}

function normalizeProcessingBlocks(
  turnId: number,
  blocks?: unknown[],
  fallbackTimestamp?: number
): ProcessingBlock[] {
  if (!blocks) return []

  return blocks.flatMap((block, index) => {
    const normalized = normalizeProcessingBlock(turnId, block, index, fallbackTimestamp)
    return normalized ? [normalized] : []
  })
}

function getResultBlocks(turnId: number, result: unknown): ProcessingBlock[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.blocks)) return undefined
  const blocks = normalizeProcessingBlocks(turnId, result.blocks)
  return blocks.length > 0 ? blocks : undefined
}

function getReasoningChunk(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  return typeof result.reasoning_chunk === 'string' ? result.reasoning_chunk : undefined
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
  payload: { device_id?: string; local_task_id?: string; subtask_id?: number },
  matched: boolean,
  details: Record<string, unknown> = {}
) {
  if (!isRuntimeWorkDebugEnabled()) return
  console.debug(`[Wework runtime] ${label}`, {
    matched,
    currentRuntimeTask: runtimeAddressDebug(address),
    payloadDeviceId: payload.device_id ?? null,
    payloadLocalTaskId: payload.local_task_id ?? null,
    payloadTurnId: payload.subtask_id ?? null,
    ...details,
  })
}
