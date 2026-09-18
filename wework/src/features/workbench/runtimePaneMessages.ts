import {
  createRuntimeTaskStreamHandlers as createTaskHandlers,
  createRuntimeConversationStreamHandlers as createConversationHandlers,
  type RuntimeTaskStreamHandlers,
  type RuntimeConversationStreamHandlers,
} from '@wegent/chat-core/runtime-stream-handlers'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
export * from '@wegent/chat-core/runtime-stream-handlers'
const diagnostics = {
  isDevelopment: import.meta.env.DEV,
  isEnabled: () =>
    ((window as Window & { __WEWORK_RUNTIME_DEBUG__?: boolean }).__WEWORK_RUNTIME_DEBUG__ ??
      false) ||
    import.meta.env.VITE_WEWORK_RUNTIME_DEBUG === '1',
}
export function createRuntimeTaskStreamHandlers(
  address: RuntimeTaskAddress,
  handlers: RuntimeTaskStreamHandlers
) {
  return createTaskHandlers(address, handlers, diagnostics)
}
export function createRuntimeConversationStreamHandlers(
  handlers: RuntimeConversationStreamHandlers
) {
  return createConversationHandlers(handlers, diagnostics)
}
