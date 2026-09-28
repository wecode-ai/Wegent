import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeSendRequest } from '@wegent/chat-core/runtime-task-api-types'
import { createRuntimeUserMessage } from './runtimeUserMessage'

export const RUNTIME_RETRY_CONTINUATION_PROMPT =
  'Continue the unfinished work from the previous turn. Use the existing conversation context and do not repeat work that is already complete.'

/** The hosts own the in-flight lock and transport; retry intent and rollback are shared. */
export async function retryRuntimeConversation({
  messageId,
  messages,
  request,
  labels,
  addUserMessage,
  removeUserMessage,
  send,
}: {
  messageId: string
  messages: WorkbenchMessage[]
  request: Omit<RuntimeSendRequest, 'message' | 'clientUserMessageId'>
  labels: { continue: string; missing: string; failed: string }
  addUserMessage(message: WorkbenchMessage & { role: 'user' }): void
  removeUserMessage(id: string): void
  send(request: RuntimeSendRequest): Promise<boolean>
}): Promise<void> {
  if (
    !messages.some(
      message =>
        message.id === messageId && message.role === 'assistant' && message.status === 'failed'
    )
  ) {
    throw new Error(labels.missing)
  }
  const clientUserMessageId = `runtime-retry-continuation-${crypto.randomUUID()}`
  addUserMessage(createRuntimeUserMessage(labels.continue, [], { id: clientUserMessageId }))
  try {
    const accepted = await send({
      ...request,
      message: RUNTIME_RETRY_CONTINUATION_PROMPT,
      clientUserMessageId,
    })
    if (!accepted) throw new Error(labels.failed)
  } catch (cause) {
    removeUserMessage(clientUserMessageId)
    throw cause
  }
}
