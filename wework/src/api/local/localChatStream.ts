import type { ChatCancelAck, ChatCancelPayload, ChatGuideAck, ChatGuidePayload } from '@/types/api'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { LocalExecutorEvent } from '@/tauri/localExecutor'
import { createResponseApiStreamState, emitResponseApiEvent } from '@/stream/responseApiStream'

interface LocalChatStreamDeps {
  subscribe: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

export function createLocalChatStream(deps: LocalChatStreamDeps) {
  return {
    sendGuidance(payload: ChatGuidePayload): Promise<ChatGuideAck> {
      return deps.request<ChatGuideAck>(
        'runtime.tasks.guidance',
        payload as unknown as Record<string, unknown>
      )
    },
    cancelStream(payload: ChatCancelPayload): Promise<ChatCancelAck> {
      return deps.request<ChatCancelAck>(
        'runtime.tasks.cancel',
        payload as unknown as Record<string, unknown>
      )
    },
    subscribe(handlers: ChatStreamHandlers): () => void {
      let cleanup: (() => void) | null = null
      let active = true
      const state = createResponseApiStreamState()

      void deps
        .subscribe(event => {
          if (active) {
            emitResponseApiEvent(handlers, event.event, event.payload, state)
          }
        })
        .then(unlisten => {
          if (active) {
            cleanup = unlisten
            return
          }
          unlisten()
        })

      return () => {
        active = false
        cleanup?.()
      }
    },
  }
}
