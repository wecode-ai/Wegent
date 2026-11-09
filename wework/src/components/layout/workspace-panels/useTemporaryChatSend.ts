import { useCallback, useRef, type Dispatch, type SetStateAction, type RefObject } from 'react'
import type { ChatSubmitOptions } from '@/components/chat/ChatInput'
import { pendingRequestUserInputPayload } from '@/components/layout/requestUserInputOverlay'
import type {
  WorkbenchContextValue,
  RuntimeTaskModelSelectionControls,
} from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { requiresNewSessionForModelSwitch } from '@/features/workbench/modelSwitch'
import { isRuntimeTaskBusyError } from '@/features/workbench/runtimePaneStatus'
import {
  appendAcceptedRuntimeConversationMessage,
  applyRuntimeConversationAction,
  getRuntimeConversationMessages,
  getRuntimeConversationTurnIds,
  removeRuntimeConversationTurn,
} from '@/features/workbench/runtimeConversationCache'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import type { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { persistAttachmentReferences } from '@/lib/attachments'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { runtimeGoalCreateInput } from '@/lib/runtime-goal'
import type {
  Attachment,
  ProjectWithTasks,
  RuntimeSendRequest,
  RuntimeTaskAddress,
} from '@/types/api'
import type {
  RuntimePaneQueuedMessage,
  RuntimeTaskComposerCreateOptions,
  WorkbenchMessage,
} from '@/types/workbench'
import type { runtimePaneQueue } from './runtimePaneQueues'
import { prepareModelSessionSwitch } from './prepareModelSessionSwitch'

type StateSetter<T> = Dispatch<SetStateAction<T>>
type SendContext = Pick<
  WorkbenchContextValue,
  | 'createTemporaryRuntimeTask'
  | 'sendRuntimePaneMessage'
  | 'interruptAndSendRuntimePaneMessage'
  | 'loadRuntimeTranscriptForPane'
>
interface TemporaryChatSendOptions extends SendContext {
  address: RuntimeTaskAddress | null
  source: RuntimeTaskAddress | null
  currentProject: ProjectWithTasks | null
  input: string
  busy: boolean
  sendEphemeral: boolean
  crossProviderSwitchBehavior?: 'new-session'
  taskModelIdentityPending: boolean
  taskModelSelection: RuntimeTaskModelSelectionControls | null
  selectedModelFields: RuntimeTaskComposerCreateOptions['executionModel']
  messages: WorkbenchMessage[]
  queuedMessages: readonly RuntimePaneQueuedMessage[]
  conversationQueue: ReturnType<typeof runtimePaneQueue>
  lifecycleStore: RuntimeTaskLifecycleStore
  runtimeContext?: Pick<RuntimeSendRequest, 'cloudProjectId' | 'origin' | 'additionalContext'>
  createTask?: (
    message: string,
    options: RuntimeTaskComposerCreateOptions
  ) => Promise<RuntimeTaskAddress | false>
  sideChatProjectChat: { attachments: Attachment[]; resetAttachments(): void }
  goalDraftActive: boolean
  t: ReturnType<typeof useTranslation>['t']
  createdAddressKeyRef: RefObject<string | null>
  draftEditVersionRef: RefObject<number>
  setAddress: StateSetter<RuntimeTaskAddress | null>
  updateAddress(address: RuntimeTaskAddress | null): void
  setMessages: StateSetter<WorkbenchMessage[]>
  setSending: StateSetter<boolean>
  setError: StateSetter<string | null>
  setGoalDraftActive: StateSetter<boolean>
  setInput: StateSetter<string>
  dismissTrialGuide(): void
  sendQueuedMessageAsGuidance(
    message: RuntimePaneQueuedMessage,
    forceActiveTurn?: boolean
  ): Promise<boolean>
}

export function useTemporaryChatSend(settings: TemporaryChatSendOptions) {
  const sessionSwitchInFlight = useRef(false)
  return useCallback(
    async (valueOverride?: string, options: ChatSubmitOptions = {}): Promise<boolean> => {
      const {
        address,
        crossProviderSwitchBehavior,
        taskModelSelection,
        messages,
        loadRuntimeTranscriptForPane,
        t,
        goalDraftActive,
        createTask,
        lifecycleStore,
        createTemporaryRuntimeTask,
        currentProject,
        input,
        busy,
        queuedMessages,
        conversationQueue,
        sideChatProjectChat,
        selectedModelFields,
        runtimeContext,
        sendQueuedMessageAsGuidance,
        sendRuntimePaneMessage,
        interruptAndSendRuntimePaneMessage,
        source,
        sendEphemeral,
        taskModelIdentityPending,
        updateAddress,
        setInput,
        setAddress,
        setMessages,
        setSending,
        setError,
        setGoalDraftActive,
        createdAddressKeyRef,
        draftEditVersionRef,
        dismissTrialGuide,
      } = settings
      const message = (valueOverride ?? input).trim()
      if (!message || sessionSwitchInFlight.current) return false
      const submittedEditVersion = draftEditVersionRef.current
      if (taskModelIdentityPending) {
        setError('正在同步任务模型配置，请稍后重试')
        return false
      }
      let sessionSwitch: Awaited<ReturnType<typeof prepareModelSessionSwitch>> = null
      if (
        crossProviderSwitchBehavior === 'new-session' &&
        address &&
        !sendEphemeral &&
        requiresNewSessionForModelSwitch(
          taskModelSelection?.activeModel,
          taskModelSelection?.selectedModel ?? null
        )
      ) {
        sessionSwitchInFlight.current = true
        setSending(true)
        try {
          sessionSwitch = await prepareModelSessionSwitch({
            address,
            lifecycle: lifecycleStore.getTask(address),
            activeModel: taskModelSelection?.activeModel,
            selectedModel: taskModelSelection?.selectedModel ?? null,
            busy:
              busy ||
              queuedMessages.length > 0 ||
              Boolean(pendingRequestUserInputPayload(messages)),
            blockedMessage: t('workbench.model_switch_new_session_blocked'),
            unresolvedMessage: t('workbench.model_switch_new_session_unresolved'),
            additionalContext: runtimeContext?.additionalContext,
            loadTranscript: loadRuntimeTranscriptForPane,
          })
        } catch (cause) {
          sessionSwitchInFlight.current = false
          setSending(false)
          setError(getErrorMessage(cause, t('workbench.project_chat_send_failed')))
          return false
        }
      }
      setError(null)
      if (draftEditVersionRef.current === submittedEditVersion) setInput('')
      dismissTrialGuide()

      const currentAttachments = sideChatProjectChat.attachments
      const initialGoal = goalDraftActive
        ? runtimeGoalCreateInput({
            objective: message,
            status: 'active',
            tokenBudget: null,
          })
        : undefined
      const queuedMessage: RuntimePaneQueuedMessage = {
        id: `queued-side-chat-${Date.now()}-${queuedMessages.length}`,
        content: message,
        status: 'queued',
        createdAt: new Date().toISOString(),
        attachments: persistAttachmentReferences(currentAttachments),
        ...selectedModelFields,
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
      if (!targetAddress) {
        const optimisticUserMessage = createRuntimeUserMessage(message, currentAttachments, {
          id: queuedMessage.id,
        })
        setMessages(current => [...current, optimisticUserMessage])
        const handleOptimisticOpen = (nextAddress: RuntimeTaskAddress) => {
          optimisticAddress = nextAddress
          createdAddressKeyRef.current = `${nextAddress.deviceId}:${nextAddress.taskId}`
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
        setSending(false)
        return false
      }
      if (!address) {
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
        busy && options.interruptWhenBusy
          ? interruptAndSendRuntimePaneMessage
          : sendRuntimePaneMessage
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
          ...sessionSwitch,
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
      sessionSwitchInFlight.current = false
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
        sideChatProjectChat.resetAttachments()
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
      if (sessionSwitch) {
        if (draftEditVersionRef.current === submittedEditVersion) setInput(message)
        handleError(sendError || t('workbench.project_chat_send_failed'))
        return false
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
    },
    [settings]
  )
}
