// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type WorkbenchMessageRole = 'user' | 'assistant' | 'system'
export type WorkbenchMessageStatus = 'pending' | 'streaming' | 'done' | 'failed'
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
  subtaskId: number
  status: WorkbenchToolBlockStatus
  createdAt: number
}

export interface WorkbenchToolBlock extends BaseWorkbenchProcessingBlock {
  type: 'tool'
  toolName: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
}

export interface WorkbenchThinkingBlock extends BaseWorkbenchProcessingBlock {
  type: 'thinking'
  content: string
}

export interface WorkbenchTextBlock extends BaseWorkbenchProcessingBlock {
  type: 'text'
  content: string
}

export interface WorkbenchFileChangesBlock<TFileChanges = unknown>
  extends BaseWorkbenchProcessingBlock {
  type: 'file_changes'
  fileChanges: TFileChanges
}

export type WorkbenchProcessingBlock<TFileChanges = unknown> =
  | WorkbenchToolBlock
  | WorkbenchThinkingBlock
  | WorkbenchTextBlock
  | WorkbenchFileChangesBlock<TFileChanges>

export interface WorkbenchMessage<TAttachment = unknown, TFileChanges = unknown> {
  id: string
  taskId?: number
  subtaskId?: number
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
  createdAt: string
}

type ProcessingBlockUpdate = {
  content?: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  status?: WorkbenchToolBlockStatus
}

export type WorkbenchMessageAction<TAttachment = unknown, TFileChanges = unknown> =
  | { type: 'reset'; messages: WorkbenchMessage<TAttachment, TFileChanges>[] }
  | { type: 'user_added'; message: WorkbenchMessage<TAttachment, TFileChanges> }
  | { type: 'assistant_started'; taskId?: number; subtaskId: number; shellType?: string }
  | {
      type: 'assistant_cached'
      taskId?: number
      subtaskId: number
      content: string
      blocks?: WorkbenchProcessingBlock<TFileChanges>[]
    }
  | {
      type: 'assistant_chunk'
      subtaskId: number
      content: string
      reasoningChunk?: string
      blocks?: WorkbenchProcessingBlock<TFileChanges>[]
    }
  | {
      type: 'assistant_done'
      subtaskId: number
      content?: string
      blocks?: WorkbenchProcessingBlock<TFileChanges>[]
      fileChanges?: TFileChanges
    }
  | {
      type: 'file_changes_updated'
      subtaskId: number
      fileChanges: TFileChanges
    }
  | { type: 'assistant_error'; subtaskId: number; error: string; errorType?: string }
  | { type: 'block_created'; subtaskId: number; block: WorkbenchProcessingBlock<TFileChanges> }
  | { type: 'block_updated'; subtaskId: number; blockId: string; updates: ProcessingBlockUpdate }

export function isGenericTaskStatusError(error?: string): boolean {
  return /^Task failed with status:\s*\w+$/i.test(String(error ?? '').trim())
}

export function reduceWorkbenchMessages<TAttachment = unknown, TFileChanges = unknown>(
  state: WorkbenchMessage<TAttachment, TFileChanges>[],
  action: WorkbenchMessageAction<TAttachment, TFileChanges>
): WorkbenchMessage<TAttachment, TFileChanges>[] {
  switch (action.type) {
    case 'reset':
      return action.messages
    case 'user_added':
      return [...state, action.message]
    case 'assistant_started':
      if (state.some(message => isAssistantMessageForSubtask(message, action.subtaskId))) {
        return state.map(message =>
          isAssistantMessageForSubtask(message, action.subtaskId)
            ? {
                ...clearMessageError(message),
                taskId: action.taskId ?? message.taskId,
                shellType: action.shellType ?? message.shellType,
                status: 'streaming' as const,
              }
            : message
        )
      }
      return [
        ...state,
        createAssistantMessage<TAttachment, TFileChanges>({
          taskId: action.taskId,
          subtaskId: action.subtaskId,
          shellType: action.shellType,
        }),
      ]
    case 'assistant_cached':
      if (state.some(message => isAssistantMessageForSubtask(message, action.subtaskId))) {
        return state.map(message =>
          isAssistantMessageForSubtask(message, action.subtaskId)
            ? {
                ...clearMessageError(message),
                taskId: action.taskId ?? message.taskId,
                content: action.content,
                status: 'streaming' as const,
                blocks: action.blocks ?? message.blocks,
              }
            : message
        )
      }
      return [
        ...state,
        createAssistantMessage<TAttachment, TFileChanges>({
          taskId: action.taskId,
          subtaskId: action.subtaskId,
          content: action.content,
          blocks: action.blocks ?? [],
        }),
      ]
    case 'assistant_chunk':
      if (!state.some(message => isAssistantMessageForSubtask(message, action.subtaskId))) {
        const message = createAssistantMessage<TAttachment, TFileChanges>({
          subtaskId: action.subtaskId,
          content: action.content,
        })
        return [
          ...state,
          {
            ...message,
            blocks: getChunkBlocks(message, action),
          },
        ]
      }
      return state.map(message =>
        isAssistantMessageForSubtask(message, action.subtaskId)
          ? {
              ...clearMessageError(message),
              content: message.content + action.content,
              status: 'streaming' as const,
              blocks: getChunkBlocks(message, action),
            }
          : message
      )
    case 'assistant_done':
      if (!state.some(message => isAssistantMessageForSubtask(message, action.subtaskId))) {
        return [
          ...state,
          createAssistantMessage<TAttachment, TFileChanges>({
            subtaskId: action.subtaskId,
            content: action.content ?? '',
            status: 'done',
            blocks: finalizeProcessingBlocks(action.blocks, 'done'),
            fileChanges: action.fileChanges,
          }),
        ]
      }
      return state.map(message =>
        isAssistantMessageForSubtask(message, action.subtaskId)
          ? {
              ...clearMessageError(message),
              content: action.content ?? message.content,
              status: 'done' as const,
              blocks: finalizeProcessingBlocks(action.blocks ?? message.blocks, 'done'),
              fileChanges: action.fileChanges ?? message.fileChanges,
            }
          : message
      )
    case 'file_changes_updated':
      return state.map(message =>
        isAssistantMessageForSubtask(message, action.subtaskId)
          ? { ...message, fileChanges: action.fileChanges }
          : message
      )
    case 'assistant_error':
      if (!state.some(message => isAssistantMessageForSubtask(message, action.subtaskId))) {
        return [
          ...state,
          createAssistantMessage<TAttachment, TFileChanges>({
            subtaskId: action.subtaskId,
            status: 'failed',
            error: action.error,
            errorType: action.errorType,
            blocks: finalizeProcessingBlocks(undefined, 'error'),
          }),
        ]
      }
      return state.map(message =>
        isAssistantMessageForSubtask(message, action.subtaskId)
          ? {
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
              blocks: finalizeProcessingBlocks(message.blocks, 'error'),
            }
          : message
      )
    case 'block_created':
      if (!state.some(message => isAssistantMessageForSubtask(message, action.subtaskId))) {
        const message = createAssistantMessage<TAttachment, TFileChanges>({
          subtaskId: action.subtaskId,
        })
        return [...state, createBlockCreatedMessage(message, action)]
      }
      return state.map(message =>
        isAssistantMessageForSubtask(message, action.subtaskId)
          ? createBlockCreatedMessage(message, action)
          : message
      )
    case 'block_updated':
      return state.map(message =>
        isAssistantMessageForSubtask(message, action.subtaskId)
          ? {
              ...withActiveStreamState(message, isActiveBlockStatus(action.updates.status)),
              blocks: (message.blocks ?? []).map(block =>
                block.id === action.blockId
                  ? ({ ...block, ...action.updates } as WorkbenchProcessingBlock<TFileChanges>)
                  : block
              ),
            }
          : message
      )
    default:
      return state
  }
}

function isAssistantMessageForSubtask<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  subtaskId: number
): boolean {
  return message.role === 'assistant' && message.subtaskId === subtaskId
}

function createAssistantMessage<TAttachment, TFileChanges>({
  taskId,
  subtaskId,
  shellType,
  content = '',
  status = 'streaming',
  blocks = [],
  fileChanges,
  error,
  errorType,
}: {
  taskId?: number
  subtaskId: number
  shellType?: string
  content?: string
  status?: WorkbenchMessageStatus
  blocks?: WorkbenchProcessingBlock<TFileChanges>[]
  fileChanges?: TFileChanges
  error?: string
  errorType?: string
}): WorkbenchMessage<TAttachment, TFileChanges> {
  return {
    id: `assistant-${subtaskId}`,
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
    createdAt: new Date().toISOString(),
  }
}

function clearMessageError<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>
): WorkbenchMessage<TAttachment, TFileChanges> {
  if (!message.error && !message.errorType) return message

  const { error: _error, errorType: _errorType, ...messageWithoutError } = message
  return messageWithoutError
}

function withActiveStreamState<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  isActive: boolean
): WorkbenchMessage<TAttachment, TFileChanges> {
  if (!isActive) return message

  return {
    ...clearMessageError(message),
    status: 'streaming',
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
  action: Extract<WorkbenchMessageAction<TAttachment, TFileChanges>, { type: 'block_created' }>
): WorkbenchMessage<TAttachment, TFileChanges> {
  const activeMessage = withActiveStreamState(message, isActiveBlockStatus(action.block.status))
  return {
    ...activeMessage,
    content: shouldMovePendingContentBeforeBlock(message, action.block)
      ? ''
      : message.content,
    blocks: mergeProcessingBlock(
      getBlocksBeforeIncomingBlock(message, action.subtaskId, action.block),
      action.block
    ),
  }
}

export function normalizeWorkbenchBlockStatus(status?: string): WorkbenchToolBlockStatus {
  const normalizedStatus = status?.trim().toLowerCase().replace(/[\s-]+/g, '_')

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
  action: Extract<WorkbenchMessageAction<TAttachment, TFileChanges>, { type: 'assistant_chunk' }>
) {
  const withReasoning = appendThinkingChunk(
    message.blocks,
    action.subtaskId,
    action.reasoningChunk
  )

  if (!action.blocks) return withReasoning
  return action.blocks.reduce(mergeProcessingBlock, withReasoning ?? [])
}

function appendThinkingChunk<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined,
  subtaskId: number,
  chunk?: string
): WorkbenchProcessingBlock<TFileChanges>[] | undefined {
  if (!chunk) return blocks

  const nextBlocks = [...(blocks ?? [])]
  const lastBlock = nextBlocks[nextBlocks.length - 1]
  if (lastBlock?.type === 'thinking' && lastBlock.status === 'streaming') {
    nextBlocks[nextBlocks.length - 1] = {
      ...lastBlock,
      content: lastBlock.content + chunk,
    }
    return nextBlocks
  }

  const thinkingCount = nextBlocks.filter(block => block.type === 'thinking').length
  return [
    ...nextBlocks,
    {
      id: `thinking-${subtaskId}-${thinkingCount + 1}`,
      subtaskId,
      type: 'thinking',
      content: chunk,
      status: 'streaming',
      createdAt: Date.now(),
    },
  ]
}

function getBlocksBeforeIncomingBlock<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  subtaskId: number,
  incomingBlock: WorkbenchProcessingBlock<TFileChanges>
): WorkbenchProcessingBlock<TFileChanges>[] {
  const finalizedBlocks = finalizeOpenNarrativeBlocks(message.blocks)
  if (!shouldMovePendingContentBeforeBlock(message, incomingBlock)) return finalizedBlocks

  return [
    ...finalizedBlocks,
    {
      id: `text-${subtaskId}-${getTextBlockCount(finalizedBlocks) + 1}`,
      subtaskId,
      type: 'text',
      content: message.content,
      status: 'done',
      createdAt: Date.now(),
    },
  ]
}

function shouldMovePendingContentBeforeBlock<TAttachment, TFileChanges>(
  message: WorkbenchMessage<TAttachment, TFileChanges>,
  incomingBlock: WorkbenchProcessingBlock<TFileChanges>
): boolean {
  return incomingBlock.type !== 'text' && message.content.trim().length > 0
}

function getTextBlockCount(blocks: WorkbenchProcessingBlock[]): number {
  return blocks.filter(block => block.type === 'text').length
}

function finalizeOpenNarrativeBlocks<TFileChanges>(
  blocks: WorkbenchProcessingBlock<TFileChanges>[] | undefined
): WorkbenchProcessingBlock<TFileChanges>[] {
  return (blocks ?? []).map(block => {
    if (
      (block.type === 'thinking' || block.type === 'text') &&
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
  return (blocks ?? []).map(block => {
    if (block.type === 'thinking' && block.status === 'streaming') {
      return { ...block, status: 'done' as const }
    }

    if (!finalStatus || block.status === 'done' || block.status === 'error') {
      return block
    }

    return { ...block, status: finalStatus } as WorkbenchProcessingBlock<TFileChanges>
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
  const index = blocks.findIndex(block => block.id === incomingBlock.id)
  if (index === -1) return [...blocks, incomingBlock]

  const nextBlocks = [...blocks]
  nextBlocks[index] = {
    ...nextBlocks[index],
    ...incomingBlock,
  } as WorkbenchProcessingBlock<TFileChanges>
  return nextBlocks
}
