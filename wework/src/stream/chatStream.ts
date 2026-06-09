import type {
  ChatBlockCreatedPayload,
  ChatBlockUpdatedPayload,
  ChatCancelAck,
  ChatCancelPayload,
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatGuideAck,
  ChatGuidePayload,
  ChatGuidanceAppliedPayload,
  ChatGuidanceExpiredPayload,
  ChatGuidanceQueuedPayload,
  ChatSendAck,
  ChatSendPayload,
  ChatStartPayload,
  TaskJoinResponse,
} from '@/types/api'
import type {
  DeviceSlotUpdatePayload,
  DeviceUpgradeStatusPayload,
} from '@/types/device-events'
import type { WorkbenchSocket } from './socketClient'

export interface ChatStreamHandlers {
  onChatStart?: (payload: ChatStartPayload) => void
  onChatChunk?: (payload: ChatChunkPayload) => void
  onChatDone?: (payload: ChatDonePayload) => void
  onChatError?: (payload: ChatErrorPayload) => void
  onBlockCreated?: (payload: ChatBlockCreatedPayload) => void
  onBlockUpdated?: (payload: ChatBlockUpdatedPayload) => void
  onGuidanceQueued?: (payload: ChatGuidanceQueuedPayload) => void
  onGuidanceApplied?: (payload: ChatGuidanceAppliedPayload) => void
  onGuidanceExpired?: (payload: ChatGuidanceExpiredPayload) => void
  onDeviceOnline?: (payload: unknown) => void
  onDeviceOffline?: (payload: unknown) => void
  onDeviceStatus?: (payload: unknown) => void
  onDeviceSlotUpdate?: (payload: DeviceSlotUpdatePayload) => void
  onDeviceUpgradeStatus?: (payload: DeviceUpgradeStatusPayload) => void
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

function normalizeGuideAck(response: ChatGuideAck | undefined): ChatGuideAck {
  if (!response) {
    return { success: false, error: '引导发送失败' }
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
    sendGuidance(payload: ChatGuidePayload): Promise<ChatGuideAck> {
      return new Promise((resolve) => {
        if (!socket.connected) {
          resolve({ success: false, error: '连接未建立，请刷新页面重试' })
          return
        }

        const timer = setTimeout(() => {
          resolve({ success: false, error: '引导发送超时，请重试' })
        }, SEND_TIMEOUT_MS)

        socket.emit('chat:guide', payload, (response: ChatGuideAck) => {
          clearTimeout(timer)
          resolve(normalizeGuideAck(response))
        })
      })
    },
    cancelStream(payload: ChatCancelPayload): Promise<ChatCancelAck> {
      return new Promise(resolve => {
        if (!socket.connected) {
          resolve({ success: false, error: '连接未建立，请刷新页面重试' })
          return
        }

        socket.emit('chat:cancel', payload, (response: ChatCancelAck) => {
          if (!response) {
            resolve({ success: false, error: '取消失败' })
            return
          }
          resolve({
            ...response,
            success: response.error ? false : response.success ?? true,
          })
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
      if (handlers.onGuidanceQueued) socket.on('chat:guidance_queued', handlers.onGuidanceQueued)
      if (handlers.onGuidanceApplied) socket.on('chat:guidance_applied', handlers.onGuidanceApplied)
      if (handlers.onGuidanceExpired) socket.on('chat:guidance_expired', handlers.onGuidanceExpired)
      if (handlers.onDeviceOnline) socket.on('device:online', handlers.onDeviceOnline)
      if (handlers.onDeviceOffline) socket.on('device:offline', handlers.onDeviceOffline)
      if (handlers.onDeviceStatus) socket.on('device:status', handlers.onDeviceStatus)
      if (handlers.onDeviceSlotUpdate) {
        socket.on('device:slot_update', handlers.onDeviceSlotUpdate)
      }
      if (handlers.onDeviceUpgradeStatus) {
        socket.on('device:upgrade_status', handlers.onDeviceUpgradeStatus)
      }

      return () => {
        if (handlers.onChatStart) socket.off('chat:start', handlers.onChatStart)
        if (handlers.onChatChunk) socket.off('chat:chunk', handlers.onChatChunk)
        if (handlers.onChatDone) socket.off('chat:done', handlers.onChatDone)
        if (handlers.onChatError) socket.off('chat:error', handlers.onChatError)
        if (handlers.onBlockCreated) socket.off('chat:block_created', handlers.onBlockCreated)
        if (handlers.onBlockUpdated) socket.off('chat:block_updated', handlers.onBlockUpdated)
        if (handlers.onGuidanceQueued) socket.off('chat:guidance_queued', handlers.onGuidanceQueued)
        if (handlers.onGuidanceApplied) socket.off('chat:guidance_applied', handlers.onGuidanceApplied)
        if (handlers.onGuidanceExpired) socket.off('chat:guidance_expired', handlers.onGuidanceExpired)
        if (handlers.onDeviceOnline) socket.off('device:online', handlers.onDeviceOnline)
        if (handlers.onDeviceOffline) socket.off('device:offline', handlers.onDeviceOffline)
        if (handlers.onDeviceStatus) socket.off('device:status', handlers.onDeviceStatus)
        if (handlers.onDeviceSlotUpdate) {
          socket.off('device:slot_update', handlers.onDeviceSlotUpdate)
        }
        if (handlers.onDeviceUpgradeStatus) {
          socket.off('device:upgrade_status', handlers.onDeviceUpgradeStatus)
        }
      }
    },
  }
}
