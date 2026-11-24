import { runtimeQueuedMessageRequest } from '@wegent/collaboration/execution/runtimeConversationQueue'
import {
  appendAcceptedRuntimeConversationMessage,
  getRuntimeConversationTurnIds,
} from '@/features/workbench/runtimeConversationCache'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import type { TemporaryChatPanelProps } from './temporaryChatPanelTypes'
import type { TemporaryChatSessionCommands } from './temporaryChatSession'

interface ConversationSendContext extends Pick<
  WorkbenchPaneContextValue,
  'sendRuntimePaneMessage' | 'interruptAndSendRuntimePaneMessage'
> {
  address: RuntimeTaskAddress | null
  active: boolean
  readOnly: boolean
  nativeConversation: boolean
  sendEphemeral: boolean
  assistantSend: TemporaryChatPanelProps['assistantSend']
  lifecycleStore: RuntimeTaskLifecycleStore
  sessionCommands: TemporaryChatSessionCommands
  setMessages: TemporaryChatSessionCommands['setMessages']
  failureText: string
}

export async function sendTemporaryConversationMessage(
  context: ConversationSendContext,
  message: RuntimePaneQueuedMessage,
  interrupt = false
) {
  const { address, active, readOnly, sessionCommands, lifecycleStore, assistantSend } = context
  if (!address || !active || readOnly || !sessionCommands.isCurrent())
    return { sent: false, error: context.failureText }
  const turnIdsBeforeSend = getRuntimeConversationTurnIds(address)
  let error: string | null = null
  let queued = false
  let guided = false
  const sendMessage = interrupt
    ? context.interruptAndSendRuntimePaneMessage
    : context.sendRuntimePaneMessage
  const request = runtimeQueuedMessageRequest(
    {
      address,
      ...(context.nativeConversation && !interrupt ? { queueIfBusy: true } : {}),
      ...(context.sendEphemeral ? { ephemeral: true } : {}),
    },
    message
  )
  const result: { sent: boolean; error?: string | null; queued?: boolean } = assistantSend
    ? await assistantSend({
        message: request.message,
        clientUserMessageId: message.id,
        attachmentIds: request.attachmentIds,
        interruptWhenBusy: interrupt,
        runtimeOptions: {
          modelId: request.modelId,
          modelType: request.modelType,
          modelOptions: request.modelOptions,
          modelSelection: request.modelSelection,
          startNewSession: request.startNewSession,
          expectedThreadId: request.expectedThreadId,
          attachments: request.attachments,
        },
      })
    : {
        sent: await sendMessage(request, {
          silentBusyRetry: context.nativeConversation,
          onError: value => {
            error = value
          },
          onGuided: () => {
            guided = true
          },
          onQueued: () => {
            queued = true
          },
        }),
      }
  if (assistantSend) {
    error = result.error ?? null
    queued = result.queued === true
  }
  if (result.sent && !queued && !guided)
    context.setMessages(
      appendAcceptedRuntimeConversationMessage(
        address,
        createRuntimeUserMessage(message.content, message.attachments ?? [], { id: message.id }),
        lifecycleStore.getTask(address)?.turn.id ?? null,
        turnIdsBeforeSend
      )
    )
  return { sent: result.sent, error, guided }
}
