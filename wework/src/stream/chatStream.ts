import type {
  ChatBlockCreatedPayload,
  ChatBlockUpdatedPayload,
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
  onBlockCreated?: (payload: ChatBlockCreatedPayload) => void
  onBlockUpdated?: (payload: ChatBlockUpdatedPayload) => void
}

const SEND_TIMEOUT_MS = 30_000

function normalizeSendAck(response: ChatSendAck | undefined): ChatSendAck {
  if (!response) {
    return { success: false, error: '发送失败' }
  }
  if (response.error) {
    return { ...response, success: false }
  }
  return { ...response, success: response.success ?? true }
}

export function createChatStream(socket: Pick<WorkbenchSocket, 'emit' | 'on' | 'off' | 'connected'>) {
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
      return new Promise((resolve) => {
        if (!socket.connected) {
          resolve({ success: false, error: '连接未建立，请刷新页面重试' })
          return
        }

        const timer = setTimeout(() => {
          resolve({ success: false, error: '发送超时，请重试' })
        }, SEND_TIMEOUT_MS)

        socket.emit('chat:send', payload, (response: ChatSendAck) => {
          clearTimeout(timer)
          resolve(normalizeSendAck(response))
        })
      })
    },
    subscribe(handlers: ChatStreamHandlers): () => void {
      if (handlers.onChatStart) socket.on('chat:start', handlers.onChatStart)
      if (handlers.onChatChunk) socket.on('chat:chunk', handlers.onChatChunk)
      if (handlers.onChatDone) socket.on('chat:done', handlers.onChatDone)
      if (handlers.onChatError) socket.on('chat:error', handlers.onChatError)
      if (handlers.onBlockCreated) socket.on('chat:block_created', handlers.onBlockCreated)
      if (handlers.onBlockUpdated) socket.on('chat:block_updated', handlers.onBlockUpdated)

      return () => {
        if (handlers.onChatStart) socket.off('chat:start', handlers.onChatStart)
        if (handlers.onChatChunk) socket.off('chat:chunk', handlers.onChatChunk)
        if (handlers.onChatDone) socket.off('chat:done', handlers.onChatDone)
        if (handlers.onChatError) socket.off('chat:error', handlers.onChatError)
        if (handlers.onBlockCreated) socket.off('chat:block_created', handlers.onBlockCreated)
        if (handlers.onBlockUpdated) socket.off('chat:block_updated', handlers.onBlockUpdated)
      }
    },
  }
}
