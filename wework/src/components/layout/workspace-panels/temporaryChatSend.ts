import { type PluginTrialGuide } from '@wegent/chat-core/composer-plugin-trial'
import type { runtimePaneQueue } from './runtimePaneQueues'
import { pendingRequestUserInputPayload } from '@/components/layout/requestUserInputOverlay'
import type { ChatSubmitOptions } from '@/components/chat/ChatInput'
import type { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { isRuntimeTaskBusyError } from '@/features/workbench/runtimePaneStatus'
import {
  appendAcceptedRuntimeConversationMessage,
  appendOptimisticRuntimeConversationGuidance,
  applyRuntimeConversationAction,
  getRuntimeConversationMessages,
  getRuntimeConversationTurnIds,
  removeRuntimeConversationTurn,
} from '@/features/workbench/runtimeConversationCache'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { getErrorMessage } from '@/lib/error-message'
import { persistAttachmentReferences } from '@/lib/attachments'
import { runtimeGoalCreateInput } from '@/lib/runtime-goal'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import type { ProjectWithTasks, RuntimeSendRequest, RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import type { Dispatch, SetStateAction } from 'react'
import type { TFunction } from 'i18next'

import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'

import type { TemporaryChatPanelProps } from './temporaryChatPanelTypes'
import type { TemporaryChatSessionCommands } from './temporaryChatSession'

interface TemporaryChatSendContext extends Pick<
  WorkbenchPaneContextValue,
  | 'createTemporaryRuntimeTask'
  | 'sendRuntimePaneGuidance'
  | 'sendRuntimePaneMessage'
  | 'interruptAndSendRuntimePaneMessage'
> {
  address: RuntimeTaskAddress | null
  source: RuntimeTaskAddress | null
  active: boolean
  readOnly: boolean
  nativeConversation: boolean
  draft: TemporaryChatPanelProps['draft']
  historySource: TemporaryChatPanelProps['historySource']
  scopedHistory: { available: boolean }
  paneStatus: { isBusy: boolean }
  sendConversationMessage(
    message: RuntimePaneQueuedMessage,
    interrupt?: boolean
  ): Promise<{ sent: boolean; error: string | null }>
  t: TFunction<'common'>
  goalDraftActive: boolean
  createTask: TemporaryChatPanelProps['createTask']
  lifecycleStore: RuntimeTaskLifecycleStore
  currentProject: ProjectWithTasks | null
  input: string
  busy: boolean
  conversationQueue: ReturnType<typeof runtimePaneQueue>
  sideChatProjectChat: Pick<
    ReturnType<typeof useWorkbenchAttachments>,
    'attachments' | 'resetAttachments'
  >
  selectedModelFields: ReturnType<typeof selectedModelExecutionFields>
  runtimeContext: TemporaryChatPanelProps['runtimeContext']
  sendQueuedMessageAsGuidance(
    message: RuntimePaneQueuedMessage,
    forceActiveTurn?: boolean
  ): Promise<boolean>
  sendEphemeral: boolean
  canSendWithCurrentModel(): boolean
  sessionStartFields: Pick<RuntimeSendRequest, 'startNewSession' | 'expectedThreadId'>
  updateAddress(address: RuntimeTaskAddress | null): void
  setInput: TemporaryChatSessionCommands['setInput']
  setError: TemporaryChatSessionCommands['setError']
  setTrialGuide: Dispatch<SetStateAction<PluginTrialGuide | null>>
  setSending: TemporaryChatSessionCommands['setSending']
  setMessages: TemporaryChatSessionCommands['setMessages']
  setAddress: Dispatch<SetStateAction<RuntimeTaskAddress | null>>
  setGoalDraftActive: Dispatch<SetStateAction<boolean>>
  setAcceptedSourceMessageIds: TemporaryChatSessionCommands['setAcceptedSourceMessageIds']
  sessionCommands: TemporaryChatSessionCommands
}

export async function sendTemporaryChatMessage(
  context: TemporaryChatSendContext,
  valueOverride?: string,
  options: ChatSubmitOptions = {}
): Promise<boolean> {
  const {
    address,
    active,
    readOnly,
    nativeConversation,
    draft,
    historySource,
    scopedHistory,
    paneStatus,
    sendConversationMessage,
    sendRuntimePaneGuidance,
    t,
    goalDraftActive,
    createTask,
    lifecycleStore,
    createTemporaryRuntimeTask,
    currentProject,
    input,
    busy,
    conversationQueue,
    sideChatProjectChat,
    selectedModelFields,
    runtimeContext,
    sendQueuedMessageAsGuidance,
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage,
    source,
    sendEphemeral,
    canSendWithCurrentModel,
    sessionStartFields,
    updateAddress,
    setInput,
    setError,
    setTrialGuide,
    setSending,
    setMessages,
    setAddress,
    setGoalDraftActive,
    setAcceptedSourceMessageIds,
    sessionCommands,
  } = context

  if (!active || readOnly || !sessionCommands.isCurrent()) return false
  const draftValue = valueOverride ?? input
  const message = draftValue.trim()
  if (!message) return false
  if (historySource && !scopedHistory.available) return false
  if (nativeConversation && sessionCommands.nativeSubmissionPending()) return false
  if (!canSendWithCurrentModel()) return false
  setError(null)
  const transactionalDraft = nativeConversation && address ? draft?.beginSubmission : undefined
  if (!transactionalDraft) setInput('')
  setTrialGuide(null)

  const currentAttachments = sideChatProjectChat.attachments
  const initialGoal = goalDraftActive
    ? runtimeGoalCreateInput({
        objective: message,
        status: 'active',
        tokenBudget: null,
      })
    : undefined
  const queuedMessage: RuntimePaneQueuedMessage = {
    id: `queued-side-chat-${crypto.randomUUID()}`,
    content: message,
    status: 'queued',
    createdAt: new Date().toISOString(),
    attachments: persistAttachmentReferences(currentAttachments),
    ...selectedModelFields,
    ...sessionStartFields,
    ...runtimeContext,
  }
  if (nativeConversation && address) {
    sessionCommands.setNativeSubmissionPending(true)
    setSending(true)
    let submission: ReturnType<NonNullable<typeof transactionalDraft>> | undefined
    try {
      if (transactionalDraft) {
        submission = transactionalDraft(draftValue)
        queuedMessage.id = submission.clientMessageId
      }
      const guideCurrentTurn =
        !queuedMessage.startNewSession && paneStatus.isBusy && options.guideWhenBusy
      const guidanceResult = guideCurrentTurn
        ? await sendRuntimePaneGuidance({
            address,
            message,
            ...(queuedMessage.conversationContext
              ? { conversationContext: queuedMessage.conversationContext }
              : {}),
            clientGuidanceId: queuedMessage.id,
            attachments: localRuntimeAttachments(currentAttachments),
            attachmentIds: remoteAttachmentIds(currentAttachments),
          })
        : null
      const result =
        guidanceResult ??
        (await sendConversationMessage(
          queuedMessage,
          !queuedMessage.startNewSession && paneStatus.isBusy && options.interruptWhenBusy
        ))
      if (!result.sent) {
        setError(result.error || t('workbench.project_chat_send_failed'))
        if (!transactionalDraft) setInput(current => current || message)
        return false
      }
      if (
        guidanceResult?.turnId &&
        !getRuntimeConversationMessages(address).some(item => item.id === queuedMessage.id)
      ) {
        setMessages(
          appendOptimisticRuntimeConversationGuidance(address, guidanceResult.turnId, queuedMessage)
        )
      }
      submission?.clearIfUnchanged()
      if (sessionCommands.isCurrent()) {
        sideChatProjectChat.resetAttachments()
        if (historySource) setAcceptedSourceMessageIds(ids => [...ids, queuedMessage.id])
      }
      return true
    } catch (cause) {
      setError(getErrorMessage(cause, t('workbench.project_chat_send_failed')))
      if (!transactionalDraft) setInput(current => current || message)
      return false
    } finally {
      submission?.release()
      sessionCommands.setNativeSubmissionPending(false)
      setSending(false)
    }
  }
  if (address && busy && !options.interruptWhenBusy) {
    conversationQueue.enqueue(queuedMessage)
    sideChatProjectChat.resetAttachments()
    if (options.guideWhenBusy) {
      return sendQueuedMessageAsGuidance(queuedMessage)
    }
    return true
  }

  setSending(true)
  const attachmentIds = remoteAttachmentIds(currentAttachments)
  const attachments = localRuntimeAttachments(currentAttachments)
  const handleError = (errorMessage: string) => {
    setError(errorMessage)
    setSending(false)
  }

  let targetAddress: RuntimeTaskAddress | false | null = address
  let optimisticAddress: RuntimeTaskAddress | null = null
  if (targetAddress && !sessionCommands.isCurrent()) return true
  if (!targetAddress) {
    const optimisticUserMessage = createRuntimeUserMessage(message, currentAttachments, {
      id: queuedMessage.id,
    })
    setMessages(current => [...current, optimisticUserMessage])
    const handleOptimisticOpen = (nextAddress: RuntimeTaskAddress) => {
      if (!sessionCommands.isCurrent()) return
      optimisticAddress = nextAddress
      sessionCommands.markCreatedAddress(nextAddress)
      setMessages(getRuntimeConversationMessages(nextAddress))
      setAddress(nextAddress)
    }
    targetAddress = createTask
      ? await createTask(message, {
          attachments: currentAttachments,
          initialGoal,
          executionModel: selectedModelFields,
          optimisticUserMessage,
          onError: handleError,
          onRuntimeTaskOptimisticOpen: handleOptimisticOpen,
        })
      : await createTemporaryRuntimeTask(message, {
          project: currentProject,
          source,
          attachments: currentAttachments,
          optimisticUserMessage,
          onError: handleError,
          onRuntimeTaskOptimisticOpen: handleOptimisticOpen,
        })
  }

  if (!targetAddress) {
    setMessages(
      optimisticAddress
        ? removeRuntimeConversationTurn(optimisticAddress, {
            clientUserMessageId: queuedMessage.id,
          })
        : current => current.filter(currentMessage => currentMessage.id !== queuedMessage.id)
    )
    updateAddress(null)
    if (nativeConversation) setInput(current => current || message)
    setSending(false)
    return false
  }
  if (!address) {
    if (!sessionCommands.isCurrent()) return true
    setMessages(getRuntimeConversationMessages(targetAddress))
    updateAddress(targetAddress)
    setGoalDraftActive(false)
    sideChatProjectChat.resetAttachments()
    setSending(false)
    return true
  }

  const deferLocalMessage = Boolean(
    pendingRequestUserInputPayload(getRuntimeConversationMessages(targetAddress))
  )
  const turnIdsBeforeSend = getRuntimeConversationTurnIds(targetAddress)
  if (!deferLocalMessage) {
    setMessages(
      applyRuntimeConversationAction(targetAddress, {
        type: 'user_added',
        message: createRuntimeUserMessage(message, currentAttachments, {
          id: queuedMessage.id,
        }),
      })
    )
  }
  let sendError: string | null = null
  let queued = false
  const sendMessage =
    busy && options.interruptWhenBusy ? interruptAndSendRuntimePaneMessage : sendRuntimePaneMessage
  const lifecycleBeforeSend = lifecycleStore.getTaskRevision(targetAddress)
  const sent = await sendMessage(
    {
      address: targetAddress,
      message,
      clientUserMessageId: queuedMessage.id,
      ...(sendEphemeral ? { ephemeral: true } : {}),
      ...selectedModelFields,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...runtimeContext,
    },
    {
      onError: errorMessage => {
        sendError = errorMessage
      },
      onQueued: () => {
        queued = true
      },
    }
  )
  if (sent) {
    if (deferLocalMessage && !queued) {
      setMessages(
        appendAcceptedRuntimeConversationMessage(
          targetAddress,
          createRuntimeUserMessage(message, currentAttachments, { id: queuedMessage.id }),
          lifecycleStore.getTask(targetAddress)?.turn.id ?? null,
          turnIdsBeforeSend
        )
      )
    }
    if (sessionCommands.isCurrent()) sideChatProjectChat.resetAttachments()
    setSending(false)
    return true
  }
  if (!deferLocalMessage) {
    setMessages(
      removeRuntimeConversationTurn(targetAddress, {
        clientUserMessageId: queuedMessage.id,
      })
    )
  }
  if (isRuntimeTaskBusyError(sendError)) {
    conversationQueue.enqueue(queuedMessage, {
      value: lifecycleBeforeSend,
    })
    sideChatProjectChat.resetAttachments()
    if (options.guideWhenBusy) {
      setSending(false)
      return sendQueuedMessageAsGuidance(queuedMessage, true)
    }
  } else {
    handleError(sendError || '发送失败')
    return false
  }
  setSending(false)
  return true
}
