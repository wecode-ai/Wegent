import type {
  ChatBlockCreatedPayload,
  ChatBlockUpdatedPayload,
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatStartPayload,
  RuntimeGoalEventPayload,
  RuntimeGuidanceAppliedPayload,
  RuntimeSubagentActivityPayload,
} from '@/types/api'
import type { DeviceSlotUpdatePayload, DeviceUpgradeStatusPayload } from '@/types/device-events'
import type { SocketClientSocket } from '@wegent/chat-core'
import {
  createResponseApiStreamState,
  emitResponseApiEvent,
  RESPONSE_API_STREAM_EVENTS,
} from './responseApiStream'

export type WorkbenchSocket = SocketClientSocket

export interface ChatStreamScope {
  deviceId?: string
  taskId?: string
}

export interface ChatStreamHandlers {
  scope?: ChatStreamScope
  onChatStart?: (payload: ChatStartPayload) => void
  onChatChunk?: (payload: ChatChunkPayload) => void
  onChatDone?: (payload: ChatDonePayload) => void
  onChatError?: (payload: ChatErrorPayload) => void
  onBlockCreated?: (payload: ChatBlockCreatedPayload) => void
  onBlockUpdated?: (payload: ChatBlockUpdatedPayload) => void
  onSubagentActivity?: (payload: RuntimeSubagentActivityPayload) => void
  onRuntimeGoalUpdated?: (payload: RuntimeGoalEventPayload) => void
  onRuntimeGoalCleared?: (payload: RuntimeGoalEventPayload) => void
  onGuidanceApplied?: (payload: RuntimeGuidanceAppliedPayload) => void
  onDeviceOnline?: (payload: unknown) => void
  onDeviceOffline?: (payload: unknown) => void
  onDeviceStatus?: (payload: unknown) => void
  onDeviceSlotUpdate?: (payload: DeviceSlotUpdatePayload) => void
  onDeviceUpgradeStatus?: (payload: DeviceUpgradeStatusPayload) => void
}

export function createChatStream(
  socket: Pick<WorkbenchSocket, 'emit' | 'on' | 'off' | 'connected'>
) {
  return {
    subscribe(handlers: ChatStreamHandlers): () => void {
      const responseState = createResponseApiStreamState()
      const responseHandlers = RESPONSE_API_STREAM_EVENTS.map(eventName => {
        const handler = (payload: unknown) => {
          emitResponseApiEvent(handlers, eventName, payload, responseState)
        }
        socket.on(eventName, handler)
        return { eventName, handler }
      })

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
        responseHandlers.forEach(({ eventName, handler }) => {
          socket.off(eventName, handler)
        })
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
