import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  markRuntimeTerminalAdditionalContextDelivered,
  readRuntimeTerminalAdditionalContext,
} from '@/lib/runtime-terminal-context'
import type { RuntimeGoalCreateInput, RuntimeSendRequest, RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneQueuedMessage, WorkbenchMessage } from '@/types/workbench'
import {
  appendAcceptedRuntimeConversationMessage,
  beginRuntimeConversationOperation,
  cacheRuntimeConversationQueuedMessages,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationTurnIds,
} from './runtimeConversationCache'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { createRuntimeUserMessage } from './runtimeUserMessage'
import type { RuntimePaneActionOptions } from './workbenchContextTypes'
import { logRuntimeQueueStage } from './runtimeQueueDiagnostics'

export interface RuntimeQueuedMessageSenderDependencies {
  lifecycleStore: Pick<RuntimeTaskLifecycleStore, 'getTask'>
  sendRuntimePaneMessage: (
    request: RuntimeSendRequest,
    options?: RuntimePaneActionOptions
  ) => Promise<boolean>
}

export interface SendRuntimeQueuedMessageOptions {
  isCurrent?: () => boolean
  appendAcceptedMessage?: boolean
  onError?: (error: string) => void
  initialGoal?: RuntimeGoalCreateInput | null
  silentBusyRetry?: boolean
}

export interface RuntimeQueuedMessageSendResult {
  accepted: boolean
  queued: boolean
  queuePosition?: number | null
}

export function createRuntimeQueuedUserMessage(
  message: RuntimePaneQueuedMessage
): WorkbenchMessage & { role: 'user' } {
  return createRuntimeUserMessage(message.displayContent ?? message.content, message.attachments, {
    id: message.id,
    createdAt: message.createdAt,
    runtimeGoalRequest: message.runtimeGoalRequest,
    codeComments: message.codeComments,
  })
}

export async function sendRuntimeQueuedMessage(
  address: RuntimeTaskAddress,
  message: RuntimePaneQueuedMessage,
  { lifecycleStore, sendRuntimePaneMessage }: RuntimeQueuedMessageSenderDependencies,
  options: SendRuntimeQueuedMessageOptions = {}
): Promise<RuntimeQueuedMessageSendResult> {
  const operation = options.isCurrent ? null : beginRuntimeConversationOperation(address)
  const isCurrent = options.isCurrent ?? operation!.isCurrent
  try {
    if (!isCurrent()) return { accepted: false, queued: false }
    const messageAttachments = message.attachments ?? []
    const attachmentIds = remoteAttachmentIds(messageAttachments)
    const attachments = localRuntimeAttachments(messageAttachments)
    const terminalContext = readRuntimeTerminalAdditionalContext(address)
    const additionalContext = { ...message.additionalContext, ...terminalContext }
    const turnIdsBeforeSend =
      options.appendAcceptedMessage === false ? null : getRuntimeConversationTurnIds(address)
    let queued = false
    let queuePosition: number | null | undefined
    const accepted = await sendRuntimePaneMessage(
      {
        address,
        message: message.content,
        clientUserMessageId: message.id,
        ...(message.modelId ? { modelId: message.modelId, modelType: message.modelType } : {}),
        ...(message.modelOptions ? { modelOptions: message.modelOptions } : {}),
        ...(options.initialGoal ? { initialGoal: options.initialGoal } : {}),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
        ...(message.cloudProjectId ? { cloudProjectId: message.cloudProjectId } : {}),
        ...(message.origin ? { origin: message.origin } : {}),
      },
      {
        isCurrent,
        onError: error => {
          if (isCurrent()) options.onError?.(error)
        },
        onQueued: response => {
          if (!isCurrent()) return
          queued = true
          queuePosition = response.queuePosition
        },
        silentBusyRetry: options.silentBusyRetry,
      }
    )
    if (!isCurrent()) return { accepted: false, queued: false }
    if (accepted && !queued && turnIdsBeforeSend !== null) {
      logRuntimeQueueStage(address, 'queue-send-writeback', {
        messageId: message.id,
        runtimeQueued: false,
        lifecyclePresent: lifecycleStore.getTask(address) !== null,
      })
      appendAcceptedRuntimeConversationMessage(
        address,
        createRuntimeQueuedUserMessage(message),
        lifecycleStore.getTask(address)?.turn.id ?? null,
        turnIdsBeforeSend
      )
    }
    if (accepted) markRuntimeTerminalAdditionalContextDelivered(terminalContext)
    return { accepted, queued, ...(queued ? { queuePosition } : {}) }
  } finally {
    operation?.dispose()
  }
}

export function retainRuntimeQueuedMessage(
  address: RuntimeTaskAddress,
  message: RuntimePaneQueuedMessage,
  queuePosition?: number | null
): void {
  const retainedMessage: RuntimePaneQueuedMessage = {
    ...message,
    status: 'queued',
    runtimeQueued: true,
    runtimeQueuePosition: queuePosition,
    runtimeTurnIdsBeforeStart: message.runtimeTurnIdsBeforeStart ?? [
      ...getRuntimeConversationTurnIds(address),
    ],
    deliveryMode: undefined,
    awaitingTurnStart: undefined,
    error: undefined,
    notice: undefined,
  }
  const messages = getRuntimeConversationQueuedMessages(address)
  const nextMessages = messages.some(item => item.id === message.id)
    ? messages.map(item => (item.id === message.id ? retainedMessage : item))
    : [...messages, retainedMessage]
  cacheRuntimeConversationQueuedMessages(address, nextMessages)
}
