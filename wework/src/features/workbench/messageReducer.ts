import type { WorkbenchMessage } from '@/types/workbench'

export type MessageAction =
  | { type: 'reset'; messages: WorkbenchMessage[] }
  | { type: 'user_added'; message: WorkbenchMessage }
  | { type: 'assistant_started'; taskId?: number; subtaskId: number }
  | { type: 'assistant_chunk'; subtaskId: number; content: string }
  | { type: 'assistant_done'; subtaskId: number; content?: string }
  | { type: 'assistant_error'; subtaskId: number; error: string }

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
          createdAt: new Date().toISOString(),
        },
      ]
    case 'assistant_chunk':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? {
              ...message,
              content: message.content + action.content,
              status: 'streaming',
            }
          : message
      )
    case 'assistant_done':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? {
              ...message,
              content: action.content ?? message.content,
              status: 'done',
            }
          : message
      )
    case 'assistant_error':
      return state.map(message =>
        message.subtaskId === action.subtaskId
          ? { ...message, status: 'failed', error: action.error }
          : message
      )
  }
}
