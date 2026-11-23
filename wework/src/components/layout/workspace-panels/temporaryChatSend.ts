import { type PluginTrialGuide } from '@wegent/chat-core/composer-plugin-trial'
import { includeDraftAttachmentGroup } from '@wegent/collaboration/composer'
import type { runtimePaneQueue } from './runtimePaneQueues'
import { pendingRequestUserInputPayload } from '@/components/layout/requestUserInputOverlay'
import type { ChatSubmitOptions } from '@/components/chat/ChatInput'
import {
  composeImageMarkupMessage,
  hasImageMarkupComments,
} from '@/components/chat/image-preview/imageEdit'
import type { RuntimePaneSendOptions } from '../workbenchPaneSessionTypes'
import type { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { isRuntimeTaskBusyError } from '@/features/workbench/runtimePaneStatus'
import {
  appendAcceptedRuntimeConversationMessage,
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
  taskModelIdentityPending: boolean
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
  queuePort: Parameters<ReturnType<typeof runtimePaneQueue>['send']>[1]
  captureAttachmentsForScope: ReturnType<
    typeof useWorkbenchAttachments
  >['captureAttachmentsForScope']
  instanceId: string
  sideChatProjectChat: Pick<
    ReturnType<typeof useWorkbenchAttachments>,
    'attachments' | 'resetAttachments' | 'addExistingAttachment'
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
  options: ChatSubmitOptions &
    Pick<RuntimePaneSendOptions, 'standaloneAttachments' | 'draftAttachmentSourceId'> = {}
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
    t,
    goalDraftActive,
    createTask,
    lifecycleStore,
    createTemporaryRuntimeTask,
    currentProject,
    input,
    busy,
    conversationQueue,
    queuePort,
    captureAttachmentsForScope,
    instanceId,
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

  if (runtimeContext?.conversationContext === 'private_discussion') {
    console.debug('[runtime-v2] private conversation submit', {
      taskId: address?.taskId,
      active,
      readOnly,
      historyAvailable: !historySource || scopedHistory.available,
      nativeSubmissionPending: sessionCommands.nativeSubmissionPending(),
      modelIdentityPending: context.taskModelIdentityPending,
    })
  }
  if (!active || readOnly || !sessionCommands.isCurrent()) return false
  const draftValue = valueOverride ?? input
  const draftText = draftValue.trim()
  const standalone = options.standaloneAttachments !== undefined
  if (
    !draftText &&
    !options.standaloneAttachments?.length &&
    (goalDraftActive || !hasImageMarkupComments(sideChatProjectChat.attachments))
  )
    return false
  if (historySource && !scopedHistory.available) return false
  if (nativeConversation && sessionCommands.nativeSubmissionPending()) return false
  if (!canSendWithCurrentModel()) return false
  setError(null)
  const transactionalDraft =
    !standalone && nativeConversation && address ? draft?.beginSubmission : undefined
  if (!standalone && !transactionalDraft) setInput('')
  if (!standalone) setTrialGuide(null)

  const currentAttachments = options.standaloneAttachments
    ? includeDraftAttachmentGroup({
        submittedAttachments: options.standaloneAttachments,
        draftAttachments: sideChatProjectChat.attachments,
        sourceAttachmentId: options.draftAttachmentSourceId,
      })
    : captureAttachmentsForScope(instanceId)
  const { content: message, attachments: messageAttachments } = composeImageMarkupMessage(
    draftText,
    currentAttachments
  )
  const resetAttachments = () => {
    if (!standalone) sideChatProjectChat.resetAttachments()
  }
  const restoreAttachments = () => {
    if (!standalone) currentAttachments.forEach(sideChatProjectChat.addExistingAttachment)
  }
  const submittedDraftEditVersion = sessionCommands.getDraftEditVersion()
  const restoreInput = () => {
    if (standalone || sessionCommands.getDraftEditVersion() !== submittedDraftEditVersion) return
    setInput(draftValue)
  }
  resetAttachments()
  const initialGoal =
    !standalone && goalDraftActive
      ? runtimeGoalCreateInput({
          objective: draftText,
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
    ...(hasImageMarkupComments(currentAttachments) ? { imageMarkupDraftText: draftText } : {}),
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
      conversationQueue.enqueue(queuedMessage)
      const interrupt =
        !queuedMessage.startNewSession && paneStatus.isBusy && options.interruptWhenBusy
      const sent = guideCurrentTurn
        ? await conversationQueue.guide(queuedMessage.id, queuePort, true)
        : await conversationQueue.send(queuedMessage.id, {
            ...queuePort,
            send: pending => sendConversationMessage(pending, Boolean(interrupt)),
          })
      const pending = conversationQueue.getSnapshot().find(item => item.id === queuedMessage.id)
      if (!sent && pending?.status !== 'queued') {
        setError(pending?.error || t('workbench.project_chat_send_failed'))
        if (!transactionalDraft) restoreInput()
        restoreAttachments()
        return false
      }
      submission?.clearIfUnchanged()
      if (sessionCommands.isCurrent() && historySource)
        setAcceptedSourceMessageIds(ids => [...ids, queuedMessage.id])
      return true
    } catch (cause) {
      setError(getErrorMessage(cause, t('workbench.project_chat_send_failed')))
      if (!transactionalDraft) restoreInput()
      restoreAttachments()
      return false
    } finally {
      submission?.release()
      sessionCommands.setNativeSubmissionPending(false)
      setSending(false)
    }
  }
  if (address && busy && !options.interruptWhenBusy) {
    conversationQueue.enqueue(queuedMessage)
    if (options.guideWhenBusy) {
      return sendQueuedMessageAsGuidance(queuedMessage)
    }
    return true
  }

  setSending(true)
  const attachmentIds = remoteAttachmentIds(messageAttachments)
  const attachments = localRuntimeAttachments(messageAttachments)
  const handleError = (errorMessage: string) => {
    setError(errorMessage)
    setSending(false)
  }

  let targetAddress: RuntimeTaskAddress | false | null = address
  let optimisticAddress: RuntimeTaskAddress | null = null
  if (targetAddress && !sessionCommands.isCurrent()) return true
  if (!targetAddress) {
    const optimisticUserMessage = createRuntimeUserMessage(message, messageAttachments, {
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
          attachments: messageAttachments,
          initialGoal,
          executionModel: selectedModelFields,
          optimisticUserMessage,
          onError: handleError,
          onRuntimeTaskOptimisticOpen: handleOptimisticOpen,
        })
      : await createTemporaryRuntimeTask(message, {
          project: currentProject,
          source,
          attachments: messageAttachments,
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
    if (nativeConversation) restoreInput()
    setSending(false)
    restoreAttachments()
    return false
  }
  if (!address) {
    if (!sessionCommands.isCurrent()) return true
    setMessages(getRuntimeConversationMessages(targetAddress))
    updateAddress(targetAddress)
    if (!standalone) setGoalDraftActive(false)
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
        message: createRuntimeUserMessage(message, messageAttachments, {
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
          createRuntimeUserMessage(message, messageAttachments, { id: queuedMessage.id }),
          lifecycleStore.getTask(targetAddress)?.turn.id ?? null,
          turnIdsBeforeSend
        )
      )
    }
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
    if (options.guideWhenBusy) {
      setSending(false)
      return sendQueuedMessageAsGuidance(queuedMessage, true)
    }
  } else {
    handleError(sendError || '发送失败')
    restoreAttachments()
    return false
  }
  setSending(false)
  return true
}
