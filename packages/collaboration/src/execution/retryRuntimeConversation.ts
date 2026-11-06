import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeSendRequest } from '@wegent/chat-core/runtime-task-api-types'
import { createRuntimeUserMessage } from './runtimeUserMessage'

export const RUNTIME_RETRY_CONTINUATION_PROMPT =
  'Continue the unfinished work from the previous turn. Use the existing conversation context and do not repeat work that is already complete.'

/** The hosts own the in-flight lock and transport; retry delivery semantics are shared. */
export async function retryRuntimeConversation({
  messageId,
  messages,
  request,
  labels,
  acceptUserMessage,
  send,
}: {
  messageId: string
  messages: WorkbenchMessage[]
  request: Omit<RuntimeSendRequest, 'message' | 'clientUserMessageId'>
  labels: { continue: string; missing: string; failed: string }
  acceptUserMessage(message: WorkbenchMessage & { role: 'user' }, turnId?: string): void
  send(
    request: RuntimeSendRequest
  ): Promise<{ accepted: boolean; queued?: boolean; turnId?: string }>
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
  const result = await send({
    ...request,
    message: RUNTIME_RETRY_CONTINUATION_PROMPT,
    clientUserMessageId,
  })
  if (!result.accepted) throw new Error(labels.failed)
  if (!result.queued) {
    acceptUserMessage(
      createRuntimeUserMessage(labels.continue, [], { id: clientUserMessageId }),
      result.turnId
    )
  }
}
