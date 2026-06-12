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

export type WorkbenchProcessingBlock = WorkbenchToolBlock | WorkbenchThinkingBlock

export interface WorkbenchMessage<TAttachment = unknown, TFileChanges = unknown> {
  id: string
  taskId?: number
  subtaskId?: number
  shellType?: string
  role: WorkbenchMessageRole
  content: string
  status: WorkbenchMessageStatus
  error?: string
  attachments?: TAttachment[]
  blocks?: WorkbenchProcessingBlock[]
  fileChanges?: TFileChanges
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
  | { type: 'assistant_cached'; taskId?: number; subtaskId: number; content: string }
  | {
      type: 'assistant_chunk'
      subtaskId: number
      content: string
      reasoningChunk?: string
      blocks?: WorkbenchProcessingBlock[]
    }
  | {
      type: 'assistant_done'
      subtaskId: number
      content?: string
      blocks?: WorkbenchProcessingBlock[]
      fileChanges?: TFileChanges
    }
  | {
      type: 'file_changes_updated'
      subtaskId: number
      fileChanges: TFileChanges
    }
  | { type: 'assistant_error'; subtaskId: number; error: string }
  | { type: 'block_created'; subtaskId: number; block: WorkbenchProcessingBlock }
  | { type: 'block_updated'; subtaskId: number; blockId: string; updates: ProcessingBlockUpdate }

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
      if (state.some(message => message.subtaskId === action.subtaskId)) {
        return state.map(message =>
          message.subtaskId === action.subtaskId
            ? {
                ...message,
                taskId: action.taskId ?? message.taskId,
                shellType: action.shellType ?? message.shellType,
                status: 'streaming' as const,
              }
            : message
        )
      }
      return [
        ...state,
        {
          id: `assistant-${action.subtaskId}`,
          taskId: action.taskId,
          subtaskId: action.subtaskId,
          shellType: action.shellType,
          role: 'assistant',
          content: '',
          status: 'streaming',
          blocks: [],
          createdAt: new Date().toISOString(),
        },
      ]
    case 'assistant_cached':
      if (state.some(message => message.subtaskId === action.subtaskId)) {
        return state.map(message =>
          message.subtaskId === action.subtaskId
            ? {
                ...message,
                taskId: action.taskId ?? message.taskId,
                content: action.content,
                status: 'streaming' as const,
              }
            : message
        )
      }
      return [
        ...state,
        {
          id: `assistant-${action.subtaskId}`,
          taskId: action.taskId,
          subtaskId: action.subtaskId,
          role: 'assistant',
          content: action.content,
          status: 'streaming',
          blocks: [],
          createdAt: new Date().toISOString(),
        },
      ]
    case 'assistant_chunk':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? {
              ...message,
              content: message.content + action.content,
              status: 'streaming' as const,
              blocks: getChunkBlocks(message, action),
            }
          : message
      )
    case 'assistant_done':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? {
              ...message,
              content: action.content ?? message.content,
              status: 'done' as const,
              blocks: action.blocks ?? finalizeProcessingBlocks(message.blocks),
              fileChanges: action.fileChanges ?? message.fileChanges,
            }
          : message
      )
    case 'file_changes_updated':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? { ...message, fileChanges: action.fileChanges }
          : message
      )
    case 'assistant_error':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? { ...message, status: 'failed' as const, error: action.error }
          : message
      )
    case 'block_created':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? {
              ...message,
              blocks: mergeProcessingBlock(finalizeThinkingBlocks(message.blocks), action.block),
            }
          : message
      )
    case 'block_updated':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? {
              ...message,
              blocks: (message.blocks ?? []).map(block =>
                block.id === action.blockId
                  ? ({ ...block, ...action.updates } as WorkbenchProcessingBlock)
                  : block
              ),
            }
          : message
      )
  }
}

export function normalizeWorkbenchBlockStatus(status?: string): WorkbenchToolBlockStatus {
  if (status === 'running') return 'pending'
  return (status as WorkbenchToolBlockStatus) ?? 'pending'
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

function appendThinkingChunk(
  blocks: WorkbenchProcessingBlock[] | undefined,
  subtaskId: number,
  chunk?: string
): WorkbenchProcessingBlock[] | undefined {
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

function finalizeThinkingBlocks(
  blocks: WorkbenchProcessingBlock[] | undefined
): WorkbenchProcessingBlock[] {
  return (blocks ?? []).map(block =>
    block.type === 'thinking' && block.status === 'streaming'
      ? { ...block, status: 'done' as const }
      : block
  )
}

function finalizeProcessingBlocks(
  blocks: WorkbenchProcessingBlock[] | undefined
): WorkbenchProcessingBlock[] | undefined {
  if (!blocks) return undefined
  return finalizeThinkingBlocks(blocks)
}

function mergeProcessingBlock(
  blocks: WorkbenchProcessingBlock[],
  incomingBlock: WorkbenchProcessingBlock
): WorkbenchProcessingBlock[] {
  const index = blocks.findIndex(block => block.id === incomingBlock.id)
  if (index === -1) return [...blocks, incomingBlock]

  const nextBlocks = [...blocks]
  nextBlocks[index] = { ...nextBlocks[index], ...incomingBlock } as WorkbenchProcessingBlock
  return nextBlocks
}
