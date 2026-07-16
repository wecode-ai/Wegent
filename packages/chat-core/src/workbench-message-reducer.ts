// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type WorkbenchMessageRole = 'user' | 'assistant' | 'system'
export type WorkbenchMessageStatus = 'pending' | 'streaming' | 'done' | 'failed'
export type WorkbenchRuntimeMessageStatus = WorkbenchMessageStatus | 'cancelled'
export type WorkbenchToolBlockStatus =
  | 'generating_arguments'
  | 'pending'
  | 'streaming'
  | 'done'
  | 'error'

export interface MessageSource {
  source: string
  [key: string]: unknown
}

export interface BaseWorkbenchProcessingBlock {
  id: string
  subtaskId: string
  status: WorkbenchToolBlockStatus
  createdAt: number
  contentTruncated?: boolean
  contentOriginalChars?: number
  contentLoadRef?: WorkbenchContentLoadRef
}

export interface WorkbenchToolBlock extends BaseWorkbenchProcessingBlock {
  type: 'tool'
  toolName: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  toolOutputTruncated?: boolean
  toolOutputOriginalBytes?: number
  toolOutputOriginalChars?: number
  toolOutputLoadRef?: WorkbenchContentLoadRef
  renderPayload?: unknown
}

export interface WorkbenchThinkingBlock extends BaseWorkbenchProcessingBlock {
  type: 'thinking'
  content: string
}

export interface WorkbenchTextBlock extends BaseWorkbenchProcessingBlock {
  type: 'text'
  content: string
}

export interface WorkbenchPlanBlock extends BaseWorkbenchProcessingBlock {
  type: 'plan'
  content: string
}

export interface WorkbenchFileChangesBlock<
  TFileChanges = unknown
> extends BaseWorkbenchProcessingBlock {
  type: 'file_changes'
  fileChanges: TFileChanges
}

export type WorkbenchProcessingBlock<TFileChanges = unknown> =
  | WorkbenchToolBlock
  | WorkbenchThinkingBlock
  | WorkbenchTextBlock
  | WorkbenchPlanBlock
  | WorkbenchFileChangesBlock<TFileChanges>

export interface WorkbenchMessage<
  TAttachment = unknown,
  TFileChanges = unknown
> {
  id: string
  taskId?: string
  subtaskId?: string
  shellType?: string
  role: WorkbenchMessageRole
  content: string
  status: WorkbenchMessageStatus
  error?: string
  errorType?: string
  attachments?: TAttachment[]
  blocks?: WorkbenchProcessingBlock<TFileChanges>[]
  fileChanges?: TFileChanges
  source?: MessageSource
  runtimeStatus?: WorkbenchRuntimeMessageStatus | null
  completedAt?: string | number | null
  stoppedNotice?: boolean | null
  streamTextOffset?: number
  contentTruncated?: boolean
  contentOriginalChars?: number
  contentLoadRef?: WorkbenchContentLoadRef
  createdAt: string
}

export interface WorkbenchContentLoadRef {
  taskId?: string
  messageId?: string
  subtaskId?: string
  blockId?: string
  kind: 'message_content' | 'block_content' | 'tool_output'
}

type ProcessingBlockUpdate = {
  content?: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  toolOutputDelta?: string
  toolOutputTruncated?: boolean
  toolOutputOriginalBytes?: number
  renderPayload?: unknown
  fileChanges?: unknown
  status?: WorkbenchToolBlockStatus
}

const MAX_LIVE_MESSAGE_CONTENT_CHARS = 200_000
const MAX_LIVE_BLOCK_CONTENT_CHARS = 120_000
const MAX_LIVE_TOOL_OUTPUT_CHARS = 64 * 1024

export type WorkbenchMessageAction<
  TAttachment = unknown,
  TFileChanges = unknown
> =
  | { type: 'reset'; messages: WorkbenchMessage<TAttachment, TFileChanges>[] }
  | { type: 'user_added'; message: WorkbenchMessage<TAttachment, TFileChanges> }
  | {
      type: 'assistant_started'
      messageId?: string
      taskId?: string
      subtaskId?: string
      shellType?: string
    }
  | {
      type: 'assistant_cached'
      messageId?: string
      taskId?: string
      subtaskId?: string
      content: string
      blocks?: WorkbenchProcessingBlock<TFileChanges>[]
    }
  | {
      type: 'assistant_chunk'
      messageId?: string
      subtaskId?: string
      content: string
      offset?: number
      reasoningChunk?: string
      blocks?: WorkbenchProcessingBlock<TFileChanges>[]
    }
  | {
      type: 'assistant_done'
      messageId?: string
      subtaskId?: string
      content?: string
      blocks?: WorkbenchProcessingBlock<TFileChanges>[]
      fileChanges?: TFileChanges
    }
  | {
      type: 'assistant_cancelled'
      messageId?: string
      subtaskId?: string
      content?: string
    }
  | {
      type: 'file_changes_updated'
      subtaskId: string
      fileChanges: TFileChanges
    }
  | {
      type: 'assistant_error'
      messageId?: string
      subtaskId?: string
      error: string
      errorType?: string
    }
  | {
      type: 'block_created'
      messageId?: string
      subtaskId?: string
      block: WorkbenchProcessingBlock<TFileChanges>
    }
  | {
      type: 'block_updated'
      messageId?: string
      subtaskId?: string
      blockId: string
      updates: ProcessingBlockUpdate
    }

export function isGenericTaskStatusError(error?: string): boolean {
  return /^Task failed with status:\s*\w+$/i.test(String(error ?? '').trim())
}

export function reduceWorkbenchMessages<
  TAttachment = unknown,
  TFileChanges = unknown
>(
  state: WorkbenchMessage<TAttachment, TFileChanges>[],
  action: WorkbenchMessageAction<TAttachment, TFileChanges>
): WorkbenchMessage<TAttachment, TFileChanges>[] {
  switch (action.type) {
    case 'reset':
      return normalizeUniqueWorkbenchMessages(action.messages).map(
        limitWorkbenchMessage
      )
    case 'user_added':
      return [...state, action.message]
    case 'assistant_started':
      if (
        state.some((message) => isAssistantMessageForAction(message, action))
      ) {
        return state.map((message) =>
          isAssistantMessageForAction(message, action)
            ? limitWorkbenchMessage({
                ...clearMessageError(message),
                taskId: action.taskId ?? message.taskId,
                shellType: action.shellType ?? message.shellType,
                status: 'streaming' as const
              })
            : message
        )
      }
      return [
        ...state,
        limitWorkbenchMessage(
          createAssistantMessage<TAttachment, TFileChanges>({
            messageId: action.messageId,
            taskId: action.taskId,
            subtaskId: action.subtaskId,
            shellType: action.shellType
          })
        )
      ]
    case 'assistant_cached':
      if (
        state.some((message) => isAssistantMessageForAction(message, action))
      ) {
        return state.map((message) =>
          isAssistantMessageForAction(message, action)
            ? limitWorkbenchMessage({
                ...clearMessageError(message),
                taskId: action.taskId ?? message.taskId,
                content: action.content,
                status: 'streaming' as const,
                blocks: action.blocks ?? message.blocks
              })
            : message
        )
      }
      return [
        ...state,
        limitWorkbenchMessage(
          createAssistantMessage<TAttachment, TFileChanges>({
            messageId: action.messageId,
            taskId: action.taskId,
            subtaskId: action.subtaskId,
            content: action.content,
            blocks: action.blocks ?? []
          })
        )
      ]
    case 'assistant_chunk':
      if (
        !state.some((message) => isAssistantMessageForAction(message, action))
      ) {
        const contentMerge = mergeWorkbenchChunkContent(
          '',
          undefined,
          undefined,
          action.content,
          action.offset
        )
        const message = createAssistantMessage<TAttachment, TFileChanges>({
          messageId: action.messageId,
          subtaskId: action.subtaskId,
          content: contentMerge.content
        })
        return [
          ...state,
          limitWorkbenchMessage({
            ...message,
            streamTextOffset: contentMerge.streamTextOffset,
            blocks: getChunkBlocks(message, action)
          })
        ]
      }
      return state.map((message) =>
        isAssistantMessageForAction(message, action)
          ? message.status === 'done'
            ? message
            : limitWorkbenchMessage({
                ...clearMessageError(message),
                ...mergeWorkbenchChunkContent(
                  message.content,
                  message.streamTextOffset,
                  message.contentOriginalChars,
                  action.content,
                  action.offset
                ),
                status: 'streaming' as const,
                blocks: getChunkBlocks(message, action)
              })
          : message
      )
    case 'assistant_done':
      if (
        !state.some((message) => isAssistantMessageForAction(message, action))
      ) {
        return [
          ...state,
          limitWorkbenchMessage(
            createAssistantMessage<TAttachment, TFileChanges>({
              messageId: action.messageId,
              subtaskId: action.subtaskId,
              content: action.content ?? '',
              status: 'done',
              blocks: finalizeProcessingBlocks(action.blocks, 'done'),
              fileChanges: action.fileChanges
            })
          )
        ]
      }
      return state.map((message) =>
        isAssistantMessageForAction(message, action)
          ? limitWorkbenchMessage({
              ...clearMessageError(message),
              content: action.content ?? message.content,
              streamTextOffset: undefined,
              // A completed response is authoritative. Do not retain a stream
              // offset or truncation metadata from a superseded partial response.
              ...(action.content !== undefined && {
                contentTruncated: undefined,
                contentOriginalChars: undefined,
                contentLoadRef: undefined
              }),
              status: 'done' as const,
              blocks: finalizeProcessingBlocks(
                action.blocks ?? message.blocks,
                'done'
              ),
              fileChanges: action.fileChanges ?? message.fileChanges
            })
          : message
      )
    case 'assistant_cancelled': {
      const completedAt = new Date().toISOString()
      const matches = state.some((message) =>
        isAssistantMessageForCancellationAction(message, action)
      )
        ? (message: WorkbenchMessage<TAttachment, TFileChanges>) =>
            isAssistantMessageForCancellationAction(message, action)
        : (message: WorkbenchMessage<TAttachment, TFileChanges>) =>
            message.role === 'assistant' && message.status === 'streaming'
      if (!state.some(matches)) {
        return [
          ...state,
          limitWorkbenchMessage(
            createAssistantMessage<TAttachment, TFileChanges>({
              messageId: action.messageId,
              subtaskId: action.subtaskId,
              content: action.content ?? '',
              status: 'done',
              runtimeStatus: 'cancelled',
              completedAt,
              stoppedNotice: true
            })
          )
        ]
      }
      return state.map((message) =>
        matches(message)
          ? limitWorkbenchMessage({
              ...clearMessageError(message),
              content: action.content ?? message.content,
              ...(action.content !== undefined && {
                contentTruncated: undefined,
                contentOriginalChars: undefined,
                contentLoadRef: undefined
              }),
              status: 'done' as const,
              runtimeStatus: 'cancelled' as const,
              completedAt,
              stoppedNotice: true,
              blocks: finalizeProcessingBlocks(message.blocks, 'done')
            })
          : message
      )
    }
    case 'file_changes_updated':
      return state.map((message) =>
        isAssistantMessageForSubtask(message, action.subtaskId)
          ? { ...message, fileChanges: action.fileChanges }
          : message
      )
    case 'assistant_error':
      if (
        !state.some((message) => isAssistantMessageForAction(message, action))
      ) {
        return [
          ...state,
          limitWorkbenchMessage(
            createAssistantMessage<TAttachment, TFileChanges>({
              messageId: action.messageId,
              subtaskId: action.subtaskId,
              status: 'failed',
              error: action.error,
              errorType: action.errorType,
              blocks: finalizeProcessingBlocks(undefined, 'error')
            })
          )
        ]
      }
      return state.map((message) =>
        isAssistantMessageForAction(message, action)
          ? limitWorkbenchMessage({
              ...message,
              status: 'failed' as const,
              error:
                message.error && isGenericTaskStatusError(action.error)
                  ? message.error
                  : action.error,
              errorType:
                message.error && isGenericTaskStatusError(action.error)
                  ? message.errorType
                  : action.errorType,
              blocks: finalizeProcessingBlocks(message.blocks, 'error')
            })
          : message
      )
    case 'block_created':
      if (
        !state.some((message) => isAssistantMessageForAction(message, action))
      ) {
        const message = createAssistantMessage<TAttachment, TFileChanges>({
          messageId: action.messageId,
          subtaskId: action.subtaskId
        })
        return [
          ...state,
          limitWorkbenchMessage(createBlockCreatedMessage(message, action))
        ]
      }
      return state.map((message) =>
        isAssistantMessageForAction(message, action)
          ? limitWorkbenchMessage(createBlockCreatedMessage(message, action))
          : message
      )
    case 'block_updated':
      return state.map((message) =>
        isAssistantMessageForAction(message, action)
          ? limitWorkbenchMessage({
              ...withActiveStreamState(
                message,
                isActiveBlockStatus(action.updates.status)
              ),
              blocks: (message.blocks ?? []).map((block) =>
                block.id === action.blockId
                  ? mergeProcessingBlockUpdate(block, action.updates)
                  : block
              )
            })
          : message
      )
    default:
      return state
  }
}

function mergeProcessingBlockUpdate<TFileChanges>(
  block: WorkbenchProcessingBlock<TFileChanges>,
  updates: ProcessingBlockUpdate
): WorkbenchProcessingBlock<TFileChanges> {
  const { toolOutputDelta, ...directUpdates } = updates
  const nextBlock = {
    ...block,
    ...directUpdates
  } as WorkbenchProcessingBlock<TFileChanges>

  if (typeof toolOutputDelta !== 'string' || block.type !== 'tool') {
    return nextBlock
  }

  const nextToolBlock = nextBlock as WorkbenchToolBlock
  const previousOutput = nextToolBlock.toolOutput
  const nextToolOutput = appendToolOutputDelta(previousOutput, toolOutputDelta)
  const previousOutputChars =
    typeof previousOutput === 'string'
      ? textCodePointLength(previousOutput)
      : previousOutput === undefined || previousOutput === null
        ? 0
        : textCodePointLength(String(previousOutput))
  const deltaChars = textCodePointLength(toolOutputDelta)
  const knownOriginalChars =
    nextToolBlock.toolOutputOriginalChars ??
    nextToolBlock.toolOutputOriginalBytes
  const nextOriginalChars =
    knownOriginalChars !== undefined && knownOriginalChars > previousOutputChars
      ? knownOriginalChars + deltaChars
      : previousOutputChars + deltaChars
  return {
    ...nextToolBlock,
    toolOutput: nextToolOutput,
    toolOutputOriginalChars: nextOriginalChars
  }
}

function limitWorkbenchMessage<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>
): WorkbenchMessage<TAttachment, TFileChanges> {
  if (message.role !== 'assistant') {
    return message
  }

  const content = limitTextContent(
    message.content,
    MAX_LIVE_MESSAGE_CONTENT_CHARS,
    message.contentOriginalChars
  )
  const blocks = message.blocks?.map(limitProcessingBlock)
  return {
    ...message,
    content: content.text,
    contentTruncated: content.truncated || undefined,
    contentOriginalChars: content.truncated ? content.originalChars : undefined,
    contentLoadRef: content.truncated
      ? messageContentLoadRef(message)
      : undefined,
    blocks
  }
}

function limitProcessingBlock<TFileChanges>(
  block: WorkbenchProcessingBlock<TFileChanges>
): WorkbenchProcessingBlock<TFileChanges> {
  if (block.type === 'tool') {
    return limitToolBlock(block) as WorkbenchProcessingBlock<TFileChanges>
  }
  if (
    block.type === 'thinking' ||
    block.type === 'text' ||
    block.type === 'plan'
  ) {
    const content = limitTextContent(
      block.content,
      MAX_LIVE_BLOCK_CONTENT_CHARS,
      block.contentOriginalChars
    )
    return {
      ...block,
      content: content.text,
      contentTruncated: content.truncated || undefined,
      contentOriginalChars: content.truncated
        ? content.originalChars
        : undefined,
      contentLoadRef: content.truncated ? blockContentLoadRef(block) : undefined
    }
  }
  return block
}

function limitToolBlock(block: WorkbenchToolBlock): WorkbenchToolBlock {
  if (typeof block.toolOutput !== 'string') return block

  const output = limitTextContent(
    block.toolOutput,
    MAX_LIVE_TOOL_OUTPUT_CHARS,
    block.toolOutputOriginalChars ?? block.toolOutputOriginalBytes
  )
  return {
    ...block,
    toolOutput: output.text,
    toolOutputTruncated:
      output.truncated || block.toolOutputTruncated || undefined,
    toolOutputOriginalBytes: output.truncated
      ? output.originalChars
      : block.toolOutputOriginalBytes,
    toolOutputOriginalChars: output.truncated
      ? output.originalChars
      : block.toolOutputOriginalChars,
    toolOutputLoadRef: output.truncated
      ? toolOutputLoadRef(block)
      : block.toolOutputLoadRef
  }
}

function limitTextContent(
  value: string,
  maxChars: number,
  knownOriginalChars?: number
): { text: string; truncated: boolean; originalChars: number } {
  const currentChars = textCodePointLength(value)
  const originalChars = Math.max(
    knownOriginalChars ?? currentChars,
    currentChars
  )
  if (currentChars <= maxChars) {
    return {
      text: value,
      truncated: originalChars > currentChars,
      originalChars
    }
  }

  return {
    text: tailTextCodePoints(value, maxChars),
    truncated: true,
    originalChars
  }
}

function messageContentLoadRef<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>
): WorkbenchContentLoadRef {
  return {
    taskId: message.taskId,
    messageId: message.id,
    subtaskId: message.subtaskId,
    kind: 'message_content'
  }
}

function blockContentLoadRef(
  block: BaseWorkbenchProcessingBlock
): WorkbenchContentLoadRef {
  return {
    subtaskId: block.subtaskId,
    blockId: block.id,
    kind: 'block_content'
  }
}

function toolOutputLoadRef(block: WorkbenchToolBlock): WorkbenchContentLoadRef {
  return {
    subtaskId: block.subtaskId,
    blockId: block.id,
    kind: 'tool_output'
  }
}

function appendToolOutputDelta(current: unknown, delta: string): unknown {
  if (
    typeof current === 'string' ||
    typeof current === 'undefined' ||
    current === null
  ) {
    return `${current ?? ''}${delta}`
  }

  return `${String(current)}${delta}`
}

function normalizeUniqueWorkbenchMessages<TAttachment, TFileChanges>(
  messages: WorkbenchMessage<TAttachment, TFileChanges>[]
): WorkbenchMessage<TAttachment, TFileChanges>[] {
  const normalized: WorkbenchMessage<TAttachment, TFileChanges>[] = []
  const indexes = new Map<string, number>()

  for (const message of messages) {
    const index = indexes.get(message.id)
    if (index === undefined) {
      indexes.set(message.id, normalized.length)
      normalized.push(message)
      continue
    }

    console.warn('[Wework] Duplicate workbench message id merged', {
      messageId: message.id,
      role: message.role,
      subtaskId: message.subtaskId ?? null,
      existingRole: normalized[index].role,
      existingSubtaskId: normalized[index].subtaskId ?? null
    })
    normalized[index] = mergeDuplicateWorkbenchMessage(
      normalized[index],
      message
    )
  }

  return normalized
}

function mergeDuplicateWorkbenchMessage<TAttachment, TFileChanges>(
  current: WorkbenchMessage<TAttachment, TFileChanges>,
  incoming: WorkbenchMessage<TAttachment, TFileChanges>
): WorkbenchMessage<TAttachment, TFileChanges> {
  return {
    ...current,
    ...incoming,
    taskId: incoming.taskId ?? current.taskId,
    subtaskId: incoming.subtaskId ?? current.subtaskId,
    shellType: incoming.shellType ?? current.shellType,
    content: mergeMessageContent(current.content, incoming.content),
    attachments: incoming.attachments ?? current.attachments,
    blocks: mergeMessageBlocks(current.blocks, incoming.blocks),
    fileChanges: incoming.fileChanges ?? current.fileChanges,
    source: incoming.source ?? current.source,
    runtimeStatus: incoming.runtimeStatus ?? current.runtimeStatus,
    completedAt: incoming.completedAt ?? current.completedAt,
    stoppedNotice: incoming.stoppedNotice ?? current.stoppedNotice,
    createdAt: current.createdAt || incoming.createdAt
  }
}

function mergeMessageContent(current: string, incoming: string): string {
  if (!incoming) return current
  if (!current) return incoming
  if (current === incoming) return current
  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current
  return `${current}${incoming}`
}

function mergeMessageBlocks<TFileChanges>(
  current: WorkbenchProcessingBlock<TFileChanges>[] | undefined,
  incoming: WorkbenchProcessingBlock<TFileChanges>[] | undefined
): WorkbenchProcessingBlock<TFileChanges>[] | undefined {
  if (!incoming) return current
  return incoming.reduce(mergeProcessingBlock, current ?? [])
}

function isAssistantMessageForAction<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  action: { messageId?: string; subtaskId?: string }
): boolean {
  if (message.role !== 'assistant') return false
  if (action.messageId) return message.id === action.messageId
  return (
    typeof action.subtaskId === 'string' &&
    message.subtaskId === action.subtaskId
  )
}

function isAssistantMessageForCancellationAction<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  action: { messageId?: string; subtaskId?: string }
): boolean {
  if (message.role !== 'assistant') return false
  if (
    typeof action.subtaskId === 'string' &&
    message.subtaskId === action.subtaskId
  )
    return true
  return Boolean(action.messageId && message.id === action.messageId)
}

function isAssistantMessageForSubtask<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  subtaskId: string
): boolean {
  return message.role === 'assistant' && message.subtaskId === subtaskId
}

function createAssistantMessage<TAttachment, TFileChanges>({
  messageId,
  taskId,
  subtaskId,
  shellType,
  content = '',
  status = 'streaming',
  blocks = [],
  fileChanges,
  error,
  errorType,
  runtimeStatus,
  completedAt,
  stoppedNotice
}: {
  messageId?: string
  taskId?: string
  subtaskId?: string
  shellType?: string
  content?: string
  status?: WorkbenchMessageStatus
  blocks?: WorkbenchProcessingBlock<TFileChanges>[]
  fileChanges?: TFileChanges
  error?: string
  errorType?: string
  runtimeStatus?: WorkbenchRuntimeMessageStatus | null
  completedAt?: string | number | null
  stoppedNotice?: boolean | null
}): WorkbenchMessage<TAttachment, TFileChanges> {
  return {
    id: messageId ?? `assistant-${subtaskId ?? Date.now()}`,
    taskId,
    subtaskId,
    shellType,
    role: 'assistant',
    content,
    status,
    blocks,
    fileChanges,
    error,
    errorType,
    runtimeStatus,
    completedAt,
    stoppedNotice,
    createdAt: new Date().toISOString()
  }
}

function clearMessageError<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>
): WorkbenchMessage<TAttachment, TFileChanges> {
  if (!message.error && !message.errorType) return message

  const {
    error: _error,
    errorType: _errorType,
    ...messageWithoutError
  } = message
  return messageWithoutError
}

function withActiveStreamState<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  isActive: boolean
): WorkbenchMessage<TAttachment, TFileChanges> {
  if (!isActive) return message

  return {
    ...clearMessageError(message),
    status: 'streaming'
  }
}

function isActiveBlockStatus(status?: WorkbenchToolBlockStatus): boolean {
  return (
    status === 'generating_arguments' ||
    status === 'pending' ||
    status === 'streaming'
  )
}

function createBlockCreatedMessage<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  action: Extract<
    WorkbenchMessageAction<TAttachment, TFileChanges>,
    { type: 'block_created' }
  >
): WorkbenchMessage<TAttachment, TFileChanges> {
  const subtaskId = action.subtaskId ?? message.subtaskId
  const activeMessage = withActiveStreamState(
    message,
    isActiveBlockStatus(action.block.status)
  )
  return {
    ...activeMessage,
    content: shouldMovePendingContentBeforeBlock(message, action.block)
      ? ''
      : message.content,
    blocks: mergeProcessingBlock(
      subtaskId
        ? getBlocksBeforeIncomingBlock(message, subtaskId, action.block)
        : (message.blocks ?? []),
      action.block
    )
  }
}

export function normalizeWorkbenchBlockStatus(
  status?: string
): WorkbenchToolBlockStatus {
  const normalizedStatus = status
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

  switch (normalizedStatus) {
    case 'generating_arguments':
    case 'pending':
    case 'streaming':
    case 'done':
    case 'error':
      return normalizedStatus
    case 'completed':
    case 'complete':
    case 'succeeded':
    case 'success':
      return 'done'
    case 'failed':
    case 'failure':
      return 'error'
    case 'running':
    case 'in_progress':
    case 'inprogress':
    default:
      return 'pending'
  }
}

function getChunkBlocks<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  action: Extract<
    WorkbenchMessageAction<TAttachment, TFileChanges>,
    { type: 'assistant_chunk' }
  >
) {
  const withReasoning = appendThinkingChunk(
    message.blocks,
    action.subtaskId ?? message.subtaskId,
    action.reasoningChunk
  )

  if (!action.blocks) return withReasoning
  return action.blocks.reduce(mergeProcessingBlock, withReasoning ?? [])
}

function mergeWorkbenchChunkContent(
  content: string,
  streamTextOffset: number | undefined,
  contentOriginalChars: number | undefined,
  incomingContent: string,
  incomingOffset: number | undefined
): {
  content: string
  streamTextOffset?: number
  contentOriginalChars?: number
} {
  if (!incomingContent) {
    return { content, streamTextOffset, contentOriginalChars }
  }

  const currentOffset =
    streamTextOffset ??
    (content.length === 0 && incomingOffset === 0 ? 0 : undefined)
  if (
    incomingOffset === undefined ||
    currentOffset === undefined ||
    incomingOffset > currentOffset
  ) {
    const incomingLength = textCodePointLength(incomingContent)
    return {
      content: content + incomingContent,
      streamTextOffset:
        incomingOffset === undefined
          ? undefined
          : incomingOffset + incomingLength,
      contentOriginalChars: nextMergedOriginalChars(
        content,
        contentOriginalChars,
        incomingLength,
        incomingOffset,
        incomingLength
      )
    }
  }

  const incomingLength = textCodePointLength(incomingContent)
  if (incomingOffset < currentOffset) {
    const coveredLength = currentOffset - incomingOffset
    if (coveredLength >= incomingLength) {
      return {
        content,
        streamTextOffset: currentOffset,
        contentOriginalChars: nextMergedOriginalChars(
          content,
          contentOriginalChars,
          0,
          incomingOffset,
          incomingLength
        )
      }
    }

    const suffix = sliceTextCodePoints(incomingContent, coveredLength)
    const suffixLength = textCodePointLength(suffix)
    return {
      content: content + suffix,
      streamTextOffset: incomingOffset + incomingLength,
      contentOriginalChars: nextMergedOriginalChars(
        content,
        contentOriginalChars,
        suffixLength,
        incomingOffset,
        incomingLength
      )
    }
  }

  return {
    content: content + incomingContent,
    streamTextOffset: incomingOffset + incomingLength,
    contentOriginalChars: nextMergedOriginalChars(
      content,
      contentOriginalChars,
      incomingLength,
      incomingOffset,
      incomingLength
    )
  }
}

function nextMergedOriginalChars(
  currentContent: string,
  currentOriginalChars: number | undefined,
  appendedChars: number,
  incomingOffset: number | undefined,
  incomingLength: number
): number {
  const currentVisibleChars = textCodePointLength(currentContent)
  const localOriginalChars =
    currentOriginalChars !== undefined &&
    currentOriginalChars > currentVisibleChars
      ? currentOriginalChars + appendedChars
      : currentVisibleChars + appendedChars
  const offsetOriginalChars =
    incomingOffset === undefined ? 0 : incomingOffset + incomingLength
  return Math.max(localOriginalChars, offsetOriginalChars)
}

function textCodePointLength(value: string): number {
  return /^[\x00-\x7F]*$/.test(value) ? value.length : Array.from(value).length
}

function sliceTextCodePoints(value: string, start: number): string {
  if (start <= 0) return value
  if (/^[\x00-\x7F]*$/.test(value)) return value.slice(start)
  return Array.from(value).slice(start).join('')
}

function tailTextCodePoints(value: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (/^[\x00-\x7F]*$/.test(value)) return value.slice(-maxChars)
  const chars = Array.from(value)
  return chars.slice(Math.max(0, chars.length - maxChars)).join('')
}

function appendThinkingChunk<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined,
  subtaskId: string | undefined,
  chunk?: string
): WorkbenchProcessingBlock<TFileChanges>[] | undefined {
  if (!chunk) return blocks
  if (!subtaskId) return blocks

  const nextBlocks = [...(blocks ?? [])]
  const lastBlock = nextBlocks[nextBlocks.length - 1]
  if (lastBlock?.type === 'thinking' && lastBlock.status === 'streaming') {
    nextBlocks[nextBlocks.length - 1] = {
      ...lastBlock,
      content: lastBlock.content + chunk
    }
    return nextBlocks
  }

  const thinkingCount = nextBlocks.filter(
    (block) => block.type === 'thinking'
  ).length
  return [
    ...nextBlocks,
    {
      id: `thinking-${subtaskId}-${thinkingCount + 1}`,
      subtaskId,
      type: 'thinking',
      content: chunk,
      status: 'streaming',
      createdAt: Date.now()
    }
  ]
}

function getBlocksBeforeIncomingBlock<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  subtaskId: string,
  incomingBlock: WorkbenchProcessingBlock<TFileChanges>
): WorkbenchProcessingBlock<TFileChanges>[] {
  const finalizedBlocks = finalizeOpenNarrativeBlocks(message.blocks)
  if (!shouldMovePendingContentBeforeBlock(message, incomingBlock))
    return finalizedBlocks

  return [
    ...finalizedBlocks,
    {
      id: `text-${subtaskId}-${getTextBlockCount(finalizedBlocks) + 1}`,
      subtaskId,
      type: 'text',
      content: message.content,
      status: 'done',
      createdAt: Date.now()
    }
  ]
}

function shouldMovePendingContentBeforeBlock<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  incomingBlock: WorkbenchProcessingBlock<TFileChanges>
): boolean {
  return incomingBlock.type !== 'text' && message.content.trim().length > 0
}

function getTextBlockCount(blocks: WorkbenchProcessingBlock[]): number {
  return blocks.filter((block) => block.type === 'text').length
}

function finalizeOpenNarrativeBlocks<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined
): WorkbenchProcessingBlock<TFileChanges>[] {
  return (blocks ?? []).map((block) => {
    if (
      (block.type === 'thinking' ||
        block.type === 'text' ||
        block.type === 'plan') &&
      block.status === 'streaming'
    ) {
      return { ...block, status: 'done' as const }
    }

    return block
  })
}

function finalizeBlocks<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined,
  finalStatus?: Extract<WorkbenchToolBlockStatus, 'done' | 'error'>
): WorkbenchProcessingBlock<TFileChanges>[] {
  return (blocks ?? []).map((block) => {
    if (block.type === 'thinking' && block.status === 'streaming') {
      return { ...block, status: 'done' as const }
    }

    if (!finalStatus || block.status === 'done' || block.status === 'error') {
      return block
    }

    return {
      ...block,
      status: finalStatus
    } as WorkbenchProcessingBlock<TFileChanges>
  })
}

function finalizeProcessingBlocks<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined,
  finalStatus: Extract<WorkbenchToolBlockStatus, 'done' | 'error'> = 'done'
): WorkbenchProcessingBlock<TFileChanges>[] | undefined {
  if (!blocks) return undefined
  return finalizeBlocks(blocks, finalStatus)
}

function mergeProcessingBlock<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[],
  incomingBlock: WorkbenchProcessingBlock<TFileChanges>
): WorkbenchProcessingBlock<TFileChanges>[] {
  const index = blocks.findIndex((block) => block.id === incomingBlock.id)
  if (index === -1) return [...blocks, incomingBlock]

  const nextBlocks = [...blocks]
  nextBlocks[index] = {
    ...nextBlocks[index],
    ...incomingBlock
  } as WorkbenchProcessingBlock<TFileChanges>
  return nextBlocks
}
