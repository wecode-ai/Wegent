import type { ToolBlock, ToolBlockStatus, WorkbenchMessage } from '@/types/workbench'

export type MessageAction =
  | { type: 'reset'; messages: WorkbenchMessage[] }
  | { type: 'user_added'; message: WorkbenchMessage }
  | { type: 'assistant_started'; taskId?: number; subtaskId: number }
  | { type: 'assistant_chunk'; subtaskId: number; content: string }
  | { type: 'assistant_done'; subtaskId: number; content?: string }
  | { type: 'assistant_error'; subtaskId: number; error: string }
  | { type: 'block_created'; subtaskId: number; block: ToolBlock }
  | { type: 'block_updated'; subtaskId: number; blockId: string; updates: Partial<Pick<ToolBlock, 'toolInput' | 'toolOutput' | 'status'>> }

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
      return [
        ...state,
        {
          id: `assistant-${action.subtaskId}`,
          taskId: action.taskId,
          subtaskId: action.subtaskId,
          role: 'assistant',
          content: '',
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
          ? { ...message, blocks: [...(message.blocks ?? []), action.block] }
          : message
      )
    case 'block_updated':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? {
              ...message,
              blocks: (message.blocks ?? []).map(block =>
                block.id === action.blockId
                  ? { ...block, ...action.updates }
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
