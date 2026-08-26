import type { RuntimeSendRequest } from '@/types/api'
import {
  applyRuntimeConversationAction,
  removeRuntimeConversationTurn,
} from './runtimeConversationCache'
import { createRuntimeUserMessage } from './runtimeUserMessage'

type SendRuntimePaneMessage = (request: RuntimeSendRequest) => Promise<boolean>

export async function sendOptimisticRuntimeUserMessage(
  request: RuntimeSendRequest,
  sendRuntimePaneMessage: SendRuntimePaneMessage
): Promise<boolean> {
  const userMessage = createRuntimeUserMessage(request.message, undefined, {
    id: request.clientUserMessageId,
  })
  const outboundRequest = {
    ...request,
    clientUserMessageId: userMessage.id,
  }

  applyRuntimeConversationAction(request.address, {
    type: 'user_added',
    message: userMessage,
  })

  try {
    const accepted = await sendRuntimePaneMessage(outboundRequest)
    if (!accepted) {
      removeRuntimeConversationTurn(request.address, {
        clientUserMessageId: userMessage.id,
      })
    }
    return accepted
  } catch (error) {
    removeRuntimeConversationTurn(request.address, {
      clientUserMessageId: userMessage.id,
    })
    throw error
  }
}
