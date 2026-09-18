import {
  emitResponseApiEvent as emitSharedEvent,
  type ResponseApiStreamState,
} from '@wegent/chat-core/response-api-stream'
import type { ChatStreamHandlers } from './chatStream'
export * from '@wegent/chat-core/response-api-stream'
export function emitResponseApiEvent(
  handlers: ChatStreamHandlers,
  eventName: string,
  rawPayload: unknown,
  state: ResponseApiStreamState
) {
  emitSharedEvent(handlers, eventName, rawPayload, state, { isDevelopment: import.meta.env.DEV })
}
