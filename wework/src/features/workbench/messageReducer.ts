import type {
  ProcessingBlock,
  ToolBlockStatus,
  WorkbenchMessage,
} from '@/types/workbench'

type ProcessingBlockUpdate = {
  content?: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  status?: ToolBlockStatus
}

export type MessageAction =
  | { type: 'reset'; messages: WorkbenchMessage[] }
  | { type: 'user_added'; message: WorkbenchMessage }
  | { type: 'assistant_started'; taskId?: number; subtaskId: number; shellType?: string }
  | { type: 'assistant_cached'; taskId?: number; subtaskId: number; content: string }
  | {
      type: 'assistant_chunk'
      subtaskId: number
      content: string
      reasoningChunk?: string
      blocks?: ProcessingBlock[]
    }
  | {
      type: 'assistant_done'
      subtaskId: number
      content?: string
      blocks?: ProcessingBlock[]
    }
  | { type: 'assistant_error'; subtaskId: number; error: string }
  | { type: 'block_created'; subtaskId: number; block: ProcessingBlock }
  | { type: 'block_updated'; subtaskId: number; blockId: string; updates: ProcessingBlockUpdate }

export function messageReducer(
  state: WorkbenchMessage[],
  action: MessageAction
): WorkbenchMessage[] {
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
            }
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
              blocks: mergeProcessingBlock(
                finalizeThinkingBlocks(message.blocks),
                action.block
              ),
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
                  ? ({ ...block, ...action.updates } as ProcessingBlock)
                  : block
              ),
            }
          : message
      )
  }
}

export function normalizeBlockStatus(status?: string): ToolBlockStatus {
  if (status === 'running') return 'pending'
  return (status as ToolBlockStatus) ?? 'pending'
}

function getChunkBlocks(
  message: WorkbenchMessage,
  action: Extract<MessageAction, { type: 'assistant_chunk' }>
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
  blocks: ProcessingBlock[] | undefined,
  subtaskId: number,
  chunk?: string
): ProcessingBlock[] | undefined {
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
  blocks: ProcessingBlock[] | undefined
): ProcessingBlock[] {
  return (blocks ?? []).map(block =>
    block.type === 'thinking' && block.status === 'streaming'
      ? { ...block, status: 'done' as const }
      : block
  )
}

function finalizeProcessingBlocks(
  blocks: ProcessingBlock[] | undefined
): ProcessingBlock[] | undefined {
  if (!blocks) return undefined
  return finalizeThinkingBlocks(blocks)
}

function mergeProcessingBlock(
  blocks: ProcessingBlock[],
  incomingBlock: ProcessingBlock
): ProcessingBlock[] {
  const index = blocks.findIndex(block => block.id === incomingBlock.id)
  if (index === -1) return [...blocks, incomingBlock]

  const nextBlocks = [...blocks]
  nextBlocks[index] = { ...nextBlocks[index], ...incomingBlock } as ProcessingBlock
  return nextBlocks
}
