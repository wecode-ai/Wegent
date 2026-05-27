import type {
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatSendAck,
  ChatSendPayload,
  ChatStartPayload,
  TaskJoinResponse,
} from '@/types/api'
import type { WorkbenchSocket } from './socketClient'

export interface ChatStreamHandlers {
  onChatStart?: (payload: ChatStartPayload) => void
  onChatChunk?: (payload: ChatChunkPayload) => void
  onChatDone?: (payload: ChatDonePayload) => void
  onChatError?: (payload: ChatErrorPayload) => void
}

export function createChatStream(socket: Pick<WorkbenchSocket, 'emit' | 'on' | 'off'>) {
  return {
    joinTask(taskId: number): Promise<TaskJoinResponse> {
      return new Promise(resolve => {
        socket.emit('task:join', { task_id: taskId }, (response: TaskJoinResponse) => {
          resolve(response)
        })
      })
    },
    leaveTask(taskId: number) {
      socket.emit('task:leave', { task_id: taskId })
    },
    sendMessage(payload: ChatSendPayload): Promise<ChatSendAck> {
      return new Promise(resolve => {
        socket.emit('chat:send', payload, (response: ChatSendAck) => {
          resolve(response)
        })
      })
    },
    subscribe(handlers: ChatStreamHandlers): () => void {
      if (handlers.onChatStart) socket.on('chat:start', handlers.onChatStart)
      if (handlers.onChatChunk) socket.on('chat:chunk', handlers.onChatChunk)
      if (handlers.onChatDone) socket.on('chat:done', handlers.onChatDone)
      if (handlers.onChatError) socket.on('chat:error', handlers.onChatError)

      return () => {
        if (handlers.onChatStart) socket.off('chat:start', handlers.onChatStart)
        if (handlers.onChatChunk) socket.off('chat:chunk', handlers.onChatChunk)
        if (handlers.onChatDone) socket.off('chat:done', handlers.onChatDone)
        if (handlers.onChatError) socket.off('chat:error', handlers.onChatError)
      }
    },
  }
}
