import type { ChatStreamHandlers } from './runtime-stream-types'
import { eventBase } from './response-api-decoder'
import { RUNTIME_TRANSCRIPT_ACK_TIMEOUT_MS, type CloudRuntimeIpcClient } from './runtime-ipc'
import type {
  RuntimeTaskAddress,
  RuntimeTranscriptRequest,
  RuntimeTranscriptResponse,
} from './runtime'
import {
  createRuntimeTaskStreamHandlers,
  type RuntimeTaskStreamHandlers,
} from './runtime-stream-handlers'
import { createResponseApiStreamState, emitResponseApiEvent } from './response-api-stream'

export interface RuntimeConversationHandlers extends RuntimeTaskStreamHandlers {
  onHistoryInvalidated?: () => void
}

/** Runtime session access uses its device/task address, never a collaboration execution ID. */
export interface RuntimeConversationClient {
  getTranscript(request: RuntimeTranscriptRequest): Promise<RuntimeTranscriptResponse>
  subscribe(address: RuntimeTaskAddress, handlers: RuntimeConversationHandlers): Promise<() => void>
  cancel(address: RuntimeTaskAddress): Promise<void>
  dispose(): void
}

export function createRuntimeConversationClient(
  ipc: CloudRuntimeIpcClient
): RuntimeConversationClient & {
  subscribeChatStream(handlers: ChatStreamHandlers): Promise<() => void>
} {
  const subscribeChatStream = async (
    handlers: ChatStreamHandlers,
    onHistoryInvalidated?: () => void
  ) => {
    let state = createResponseApiStreamState()
    return ipc.subscribe(event => {
      if (event.event === 'executor.event_lagged' || event.event === 'executor.runtime_replaced') {
        state = createResponseApiStreamState()
        onHistoryInvalidated?.()
        return
      }
      // Scope before decoding: other tasks must not reset this task's tool context.
      const address = eventBase(event.payload)
      if (
        handlers.scope &&
        (address.deviceId !== handlers.scope.deviceId || address.taskId !== handlers.scope.taskId)
      )
        return
      emitResponseApiEvent(handlers, event.event, event.payload, state)
    })
  }
  return {
    subscribeChatStream,
    async getTranscript(request) {
      assertRuntimeAddress(request)
      const transcript = await ipc.request<RuntimeTranscriptResponse>(
        'runtime.tasks.transcript',
        { ...request },
        request.deviceId,
        RUNTIME_TRANSCRIPT_ACK_TIMEOUT_MS
      )
      if (!Array.isArray(transcript.turns)) {
        throw new Error('Runtime transcript response is missing canonical turns')
      }
      return transcript
    },
    async subscribe(address, handlers) {
      assertRuntimeAddress(address)
      return subscribeChatStream(
        createRuntimeTaskStreamHandlers(address, handlers),
        handlers.onHistoryInvalidated
      )
    },
    async cancel(address) {
      assertRuntimeAddress(address)
      const result = await ipc.request<{
        accepted: boolean
        error?: string | null
      }>('runtime.tasks.cancel', { ...address }, address.deviceId)
      if (!result.accepted)
        throw new Error(result.error || 'Runtime did not accept the stop request')
    },
    dispose: () => ipc.dispose(),
  }
}

function assertRuntimeAddress(address: RuntimeTaskAddress): void {
  if (!address.deviceId.trim() || !address.taskId.trim()) {
    throw new Error('Runtime conversation requires a deviceId and taskId')
  }
}
