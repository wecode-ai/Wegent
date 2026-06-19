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
import type { SocketClientSocket } from '@wegent/chat-core'

export type WorkbenchSocket = SocketClientSocket & {
  connectDevice?: (deviceId: string) => Promise<void>
  setActiveDevice?: (deviceId: string | null) => void
  isDeviceConnected?: (deviceId: string) => boolean
}

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

export function createChatStream(
  socket: Pick<
    WorkbenchSocket,
    'emit' | 'on' | 'off' | 'connected' | 'connectDevice' | 'isDeviceConnected'
    | 'setActiveDevice'
  >
) {
  return {
    connectDevice(deviceId: string): Promise<void> {
      return socket.connectDevice?.(deviceId) ?? Promise.resolve()
    },
    setActiveDevice(deviceId: string | null): void {
      socket.setActiveDevice?.(deviceId)
    },
    isDeviceConnected(deviceId: string): boolean {
      return socket.isDeviceConnected?.(deviceId) ?? socket.connected
    },
    joinTask(taskId: number, deviceId?: string | null): Promise<TaskJoinResponse> {
      return new Promise(resolve => {
        socket.emit(
          'task:join',
          {
            task_id: taskId,
            ...(deviceId ? { device_id: deviceId } : {}),
          },
          (response: unknown) => {
            resolve((response ?? {}) as TaskJoinResponse)
          }
        )
      })
    },
    leaveTask(taskId: number) {
      socket.emit('task:leave', { task_id: taskId })
    },
    sendMessage(payload: ChatSendPayload): Promise<ChatSendAck> {
      return new Promise(resolve => {
        if (!socket.connected) {
          resolve({ success: false, error: '连接未建立，请刷新页面重试' })
          return
        }

        const timer = setTimeout(() => {
          resolve({ success: false, error: '发送超时，请重试' })
        }, SEND_TIMEOUT_MS)

        socket.emit('chat:send', payload, (response: unknown) => {
          clearTimeout(timer)
          resolve(normalizeSendAck(response as ChatSendAck | undefined))
        })
      })
    },
    sendGuidance(payload: ChatGuidePayload): Promise<ChatGuideAck> {
      return new Promise(resolve => {
        if (!socket.connected) {
          resolve({ success: false, error: '连接未建立，请刷新页面重试' })
          return
        }

        const timer = setTimeout(() => {
          resolve({ success: false, error: '引导发送超时，请重试' })
        }, SEND_TIMEOUT_MS)

        socket.emit('chat:guide', payload, (response: unknown) => {
          clearTimeout(timer)
          resolve(normalizeGuideAck(response as ChatGuideAck | undefined))
        })
      })
    },
    cancelStream(payload: ChatCancelPayload): Promise<ChatCancelAck> {
      return new Promise(resolve => {
        if (!socket.connected) {
          resolve({ success: false, error: '连接未建立，请刷新页面重试' })
          return
        }

        socket.emit('chat:cancel', payload, (response: unknown) => {
          const ack = response as ChatCancelAck | undefined
          if (!ack) {
            resolve({ success: false, error: '取消失败' })
            return
          }
          resolve({
            ...ack,
            success: ack.error ? false : (ack.success ?? true),
          })
        })
      })
    },
    subscribe(handlers: ChatStreamHandlers): () => void {
      const onChatStart = handlers.onChatStart
        ? (payload: unknown) => handlers.onChatStart?.(payload as ChatStartPayload)
        : undefined
      const onChatChunk = handlers.onChatChunk
        ? (payload: unknown) => handlers.onChatChunk?.(payload as ChatChunkPayload)
        : undefined
      const onChatDone = handlers.onChatDone
        ? (payload: unknown) => handlers.onChatDone?.(payload as ChatDonePayload)
        : undefined
      const onChatError = handlers.onChatError
        ? (payload: unknown) => handlers.onChatError?.(payload as ChatErrorPayload)
        : undefined
      const onBlockCreated = handlers.onBlockCreated
        ? (payload: unknown) => handlers.onBlockCreated?.(payload as ChatBlockCreatedPayload)
        : undefined
      const onBlockUpdated = handlers.onBlockUpdated
        ? (payload: unknown) => handlers.onBlockUpdated?.(payload as ChatBlockUpdatedPayload)
        : undefined
      const onGuidanceQueued = handlers.onGuidanceQueued
        ? (payload: unknown) => handlers.onGuidanceQueued?.(payload as ChatGuidanceQueuedPayload)
        : undefined
      const onGuidanceApplied = handlers.onGuidanceApplied
        ? (payload: unknown) => handlers.onGuidanceApplied?.(payload as ChatGuidanceAppliedPayload)
        : undefined
      const onGuidanceExpired = handlers.onGuidanceExpired
        ? (payload: unknown) => handlers.onGuidanceExpired?.(payload as ChatGuidanceExpiredPayload)
        : undefined
      const onDeviceSlotUpdate = handlers.onDeviceSlotUpdate
        ? (payload: unknown) => handlers.onDeviceSlotUpdate?.(payload as DeviceSlotUpdatePayload)
        : undefined
      const onDeviceUpgradeStatus = handlers.onDeviceUpgradeStatus
        ? (payload: unknown) =>
            handlers.onDeviceUpgradeStatus?.(payload as DeviceUpgradeStatusPayload)
        : undefined

      if (onChatStart) socket.on('chat:start', onChatStart)
      if (onChatChunk) socket.on('chat:chunk', onChatChunk)
      if (onChatDone) socket.on('chat:done', onChatDone)
      if (onChatError) socket.on('chat:error', onChatError)
      if (onBlockCreated) socket.on('chat:block_created', onBlockCreated)
      if (onBlockUpdated) socket.on('chat:block_updated', onBlockUpdated)
      if (onGuidanceQueued) socket.on('chat:guidance_queued', onGuidanceQueued)
      if (onGuidanceApplied) socket.on('chat:guidance_applied', onGuidanceApplied)
      if (onGuidanceExpired) socket.on('chat:guidance_expired', onGuidanceExpired)
      if (handlers.onDeviceOnline) socket.on('device:online', handlers.onDeviceOnline)
      if (handlers.onDeviceOffline) socket.on('device:offline', handlers.onDeviceOffline)
      if (handlers.onDeviceStatus) socket.on('device:status', handlers.onDeviceStatus)
      if (onDeviceSlotUpdate) socket.on('device:slot_update', onDeviceSlotUpdate)
      if (onDeviceUpgradeStatus) socket.on('device:upgrade_status', onDeviceUpgradeStatus)

      return () => {
        if (onChatStart) socket.off('chat:start', onChatStart)
        if (onChatChunk) socket.off('chat:chunk', onChatChunk)
        if (onChatDone) socket.off('chat:done', onChatDone)
        if (onChatError) socket.off('chat:error', onChatError)
        if (onBlockCreated) socket.off('chat:block_created', onBlockCreated)
        if (onBlockUpdated) socket.off('chat:block_updated', onBlockUpdated)
        if (onGuidanceQueued) socket.off('chat:guidance_queued', onGuidanceQueued)
        if (onGuidanceApplied) socket.off('chat:guidance_applied', onGuidanceApplied)
        if (onGuidanceExpired) socket.off('chat:guidance_expired', onGuidanceExpired)
        if (handlers.onDeviceOnline) socket.off('device:online', handlers.onDeviceOnline)
        if (handlers.onDeviceOffline) socket.off('device:offline', handlers.onDeviceOffline)
        if (handlers.onDeviceStatus) socket.off('device:status', handlers.onDeviceStatus)
        if (onDeviceSlotUpdate) socket.off('device:slot_update', onDeviceSlotUpdate)
        if (onDeviceUpgradeStatus) socket.off('device:upgrade_status', onDeviceUpgradeStatus)
      }
    },
  }
}
