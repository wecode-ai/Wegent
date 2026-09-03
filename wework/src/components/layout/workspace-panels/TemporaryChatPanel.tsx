import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, MessageCircle } from 'lucide-react'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import type { ChatSubmitOptions, ProjectWorkControls } from '@/components/chat/ChatInput'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import {
  DESKTOP_CHAT_CONTENT_WIDTH_CLASS,
  DESKTOP_MESSAGE_LIST_CLASS,
} from '@/components/layout/desktopChatLayout'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import {
  deriveRuntimePaneStatus,
  isRuntimeTaskBusyError,
} from '@/features/workbench/runtimePaneStatus'
import {
  appendAcceptedRuntimeConversationMessage,
  abortRuntimeConversationHydration,
  applyRuntimeConversationAction,
  beginRuntimeConversationHydration,
  completeRuntimeConversationHydration,
  getRuntimeConversationMessages,
  getRuntimeConversationTurnIds,
  removeRuntimeConversationTurn,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import {
  resolveTemporaryChatActiveModel,
  resolveTemporaryChatModelSelection,
} from '@/features/workbench/temporaryChatModelContext'
import {
  consumeRuntimeTaskLifecycleBlock,
  type RuntimeTaskLifecycleSnapshot,
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { persistAttachmentReferences } from '@/lib/attachments'
import { focusComposerAtEnd } from '@/lib/workbenchComposerFocus'
import { runtimeGoalCreateInput } from '@/lib/runtime-goal'
import { createAppliedRuntimeGuidanceMessage } from '@/features/workbench/runtimeGuidanceMessages'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  Attachment,
  ModelOptions,
  ModelType,
  ProjectWithTasks,
  RuntimeSendRequest,
  RuntimeGoalCreateInput,
  RuntimeTaskAddress,
} from '@/types/api'
import type { RuntimePaneQueuedMessage, WorkbenchMessage } from '@/types/workbench'

export interface RuntimeTaskComposerCreateOptions {
  attachments: Attachment[]
  initialGoal?: RuntimeGoalCreateInput
  executionModel: {
    modelId?: string
    modelType?: ModelType | null
    modelOptions?: ModelOptions
  }
  optimisticUserMessage: WorkbenchMessage & { role: 'user' }
  onError: (message: string) => void
  onRuntimeTaskOptimisticOpen: (address: RuntimeTaskAddress) => void
}

interface TemporaryChatPanelProps {
  currentProject: ProjectWithTasks | null
  source: RuntimeTaskAddress | null
  instanceId: string
  testId?: string
  initialInput?: string
  autoSubmitInitialInput?: boolean
  initialAddress?: RuntimeTaskAddress | null
  createTask?: (
    message: string,
    options: RuntimeTaskComposerCreateOptions
  ) => Promise<RuntimeTaskAddress | false>
  onAddressChange?: (address: RuntimeTaskAddress | null) => void
  runtimeContext?: Pick<RuntimeSendRequest, 'cloudProjectId' | 'origin' | 'additionalContext'>
  sendEphemeral?: boolean
  emptyStateText?: string
  placeholder?: string
  allowInitialGoal?: boolean
  expanded?: boolean
  wideComposer?: boolean
  collapseComposerWhenIdle?: boolean
  projectWork?: ProjectWorkControls
  showProjectWorkBar?: boolean
  projectWorkBarMiddleContext?: ReactNode
  projectWorkBarTrailingContext?: ReactNode
  onRestoreConversation?: () => void
}

export function TemporaryChatPanel({
  currentProject,
  source,
  instanceId,
  testId = 'right-workspace-chat-panel',
  initialInput = '',
  autoSubmitInitialInput = false,
  initialAddress = null,
  createTask,
  onAddressChange,
  runtimeContext,
  sendEphemeral = true,
  emptyStateText = '临时聊天不会出现在左侧任务列表。',
  placeholder = '要求后续变更',
  allowInitialGoal = false,
  expanded = false,
  wideComposer = false,
  collapseComposerWhenIdle = false,
  projectWork,
  showProjectWorkBar = false,
  projectWorkBarMiddleContext,
  projectWorkBarTrailingContext,
  onRestoreConversation,
}: TemporaryChatPanelProps) {
  const { t } = useTranslation('common')
  const {
    services,
    state,
    projectChat,
    createTemporaryRuntimeTask,
    sendRuntimePaneMessage,
    sendRuntimePaneGuidance,
    cancelRuntimePaneTask,
    subscribeRuntimeTaskStream,
    loadRuntimeTranscriptForPane,
  } = useWorkbenchPaneContext()
  const attachmentSelection = useWorkbenchAttachments({
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
    scopeKey: instanceId,
  })
  const [address, setAddress] = useState<RuntimeTaskAddress | null>(initialAddress)
  const activeModel = useMemo(
    () => resolveTemporaryChatActiveModel(projectChat.models, state.runtimeWork, address),
    [address, projectChat.models, state.runtimeWork]
  )
  const activeModelSelection = useMemo(
    () => resolveTemporaryChatModelSelection(state.runtimeWork, address),
    [address, state.runtimeWork]
  )
  const globalSelectedModel = projectChat.getSelectedModel?.() ?? projectChat.selectedModel
  const globalSelectedModelOptions =
    projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
  const taskModelIdentityPending = Boolean(address && !activeModelSelection)
  const sideChatProjectChat = useMemo(
    () => ({
      ...projectChat,
      activeModel,
      hasConversationContext: Boolean(address),
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
    }),
    [activeModel, address, attachmentSelection, projectChat]
  )
  const [messages, setMessages] = useState<WorkbenchMessage[]>(() =>
    initialAddress ? getRuntimeConversationMessages(initialAddress) : []
  )
  const [input, setInput] = useState(initialInput)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [goalDraftActive, setGoalDraftActive] = useState(false)
  const [queuedMessages, setQueuedMessages] = useState<RuntimePaneQueuedMessage[]>([])
  const [loadingFullTranscript, setLoadingFullTranscript] = useState(false)
  const lifecycleStore = useRuntimeTaskLifecycleStore()
  const taskLifecycle = useRuntimeTaskLifecycle(address)
  const paneStatus = useMemo(
    () =>
      deriveRuntimePaneStatus({
        messages,
        currentRuntimeTask: address,
        lifecycle: taskLifecycle,
      }),
    [address, messages, taskLifecycle]
  )
  const busy = sending || paneStatus.isBusy
  const queuedMessageSendInFlightIdsRef = useRef(new Set<string>())
  const queuedMessageBusyBlocksRef = useRef(new Map<string, RuntimeTaskLifecycleSnapshot | null>())
  const queuedMessagesRef = useRef(queuedMessages)
  const createdAddressKeyRef = useRef<string | null>(null)
  const autoSubmittedInitialInputRef = useRef(false)

  useEffect(() => {
    queuedMessagesRef.current = queuedMessages
  }, [queuedMessages])

  useEffect(() => {
    queuedMessageBusyBlocksRef.current.clear()
  }, [address])

  const updateAddress = useCallback(
    (nextAddress: RuntimeTaskAddress | null) => {
      setAddress(nextAddress)
      onAddressChange?.(nextAddress)
    },
    [onAddressChange]
  )

  useEffect(() => {
    if (!initialInput) return
    const frame = requestAnimationFrame(() => {
      focusComposerAtEnd(
        document.querySelector<HTMLElement>(
          `[data-testid="${testId}"] [data-testid="chat-message-input"]`
        )
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [initialInput, testId])

  useEffect(() => {
    if (!address) return
    const syncMessages = () => {
      const nextMessages = getRuntimeConversationMessages(address)
      if (nextMessages.length > 0) {
        setMessages(nextMessages)
        setError(null)
      }
    }
    return subscribeRuntimeConversation(address, syncMessages)
  }, [address])

  useEffect(() => {
    if (!address || sendEphemeral) return
    if (createdAddressKeyRef.current === `${address.deviceId}:${address.taskId}`) return
    let cancelled = false
    const hydrationToken = beginRuntimeConversationHydration(address)
    void loadRuntimeTranscriptForPane(address)
      .then(transcript => {
        if (cancelled) {
          abortRuntimeConversationHydration(address, hydrationToken)
          return
        }
        lifecycleStore.syncTranscript(address, transcript, {
          preserveActiveTurn: lifecycleStore.getTask(address)?.derived.isTurnActive ?? false,
        })
        const nextMessages = completeRuntimeConversationHydration(
          address,
          hydrationToken,
          transcript.turns
        )
        if (nextMessages.length > 0) setMessages(nextMessages)
      })
      .catch(caughtError => {
        abortRuntimeConversationHydration(address, hydrationToken)
        if (!cancelled && getRuntimeConversationMessages(address).length === 0) {
          setError(caughtError instanceof Error ? caughtError.message : '加载临时聊天失败')
        }
      })
    return () => {
      cancelled = true
      abortRuntimeConversationHydration(address, hydrationToken)
    }
  }, [address, lifecycleStore, loadRuntimeTranscriptForPane, sendEphemeral])

  const loadFullTranscript = useCallback(async () => {
    if (!address || loadingFullTranscript) return
    setLoadingFullTranscript(true)
    const hydrationToken = beginRuntimeConversationHydration(address)
    try {
      const transcript = await loadRuntimeTranscriptForPane(address, {
        includeFullContent: true,
        refresh: true,
      })
      lifecycleStore.syncTranscript(address, transcript, {
        preserveActiveTurn: lifecycleStore.getTask(address)?.derived.isTurnActive ?? false,
      })
      const nextMessages = completeRuntimeConversationHydration(
        address,
        hydrationToken,
        transcript.turns
      )
      if (nextMessages.length > 0) {
        setMessages(nextMessages)
      }
    } catch (caughtError) {
      abortRuntimeConversationHydration(address, hydrationToken)
      setError(caughtError instanceof Error ? caughtError.message : '加载完整输出失败')
    } finally {
      setLoadingFullTranscript(false)
    }
  }, [address, lifecycleStore, loadRuntimeTranscriptForPane, loadingFullTranscript])

  useEffect(() => {
    if (!address) return
    return subscribeRuntimeTaskStream(address, {
      onMessageAction: () => undefined,
      onAssistantStart: () => setSending(false),
      onAssistantSettled: () => setSending(false),
      onGuidanceApplied: payload => {
        const guidanceMessage = queuedMessagesRef.current.find(
          message =>
            message.status === 'sending' &&
            message.deliveryMode === 'guidance' &&
            (message.id === payload.clientGuidanceId ||
              (!payload.clientGuidanceId && message.content === payload.message))
        )
        if (!guidanceMessage) return
        const remainingMessages = queuedMessagesRef.current.filter(
          message => message.id !== guidanceMessage.id
        )
        queuedMessagesRef.current = remainingMessages
        setQueuedMessages(remainingMessages)
        setMessages(current => [
          ...current.filter(message => message.id !== guidanceMessage.id),
          createAppliedRuntimeGuidanceMessage(guidanceMessage, payload),
        ])
      },
    })
  }, [address, subscribeRuntimeTaskStream])

  const selectedModelFields = useMemo(() => {
    if (address && activeModelSelection) {
      return {
        modelId: activeModelSelection.modelName,
        modelType: activeModelSelection.modelType,
        modelOptions: activeModelSelection.options ?? {},
      }
    }
    return selectedModelExecutionFields(globalSelectedModel, globalSelectedModelOptions)
  }, [activeModelSelection, address, globalSelectedModel, globalSelectedModelOptions])

  useEffect(() => {
    if (!address) return
    console.info('[runtime-v2] task conversation identity resolved', {
      deviceId: address.deviceId,
      taskId: address.taskId,
      taskModel: activeModelSelection?.modelName ?? null,
      taskModelType: activeModelSelection?.modelType ?? null,
      resolvedCatalogModel: activeModel?.name ?? null,
      globalComposerModel: globalSelectedModel?.name ?? null,
    })
  }, [activeModel, activeModelSelection, address, globalSelectedModel])

  const sendQueuedMessage = useCallback(
    async (queuedMessage: RuntimePaneQueuedMessage) => {
      if (!address || queuedMessageSendInFlightIdsRef.current.has(queuedMessage.id)) return
      queuedMessageSendInFlightIdsRef.current.add(queuedMessage.id)
      setQueuedMessages(messages =>
        messages.map(message =>
          message.id === queuedMessage.id ? { ...message, status: 'sending' } : message
        )
      )

      try {
        let sendError: string | null = null
        const messageAttachments = queuedMessage.attachments ?? []
        const attachmentIds = remoteAttachmentIds(messageAttachments)
        const attachments = localRuntimeAttachments(messageAttachments)
        const turnIdsBeforeSend = getRuntimeConversationTurnIds(address)
        const sent = await sendRuntimePaneMessage(
          {
            address,
            message: queuedMessage.content,
            clientUserMessageId: queuedMessage.id,
            ...(sendEphemeral ? { ephemeral: true } : {}),
            ...(queuedMessage.modelId
              ? {
                  modelId: queuedMessage.modelId,
                  modelType: queuedMessage.modelType,
                }
              : {}),
            ...(queuedMessage.modelOptions ? { modelOptions: queuedMessage.modelOptions } : {}),
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
            ...runtimeContext,
          },
          {
            onError: message => {
              sendError = message
            },
          }
        )
        if (sent) {
          queuedMessageBusyBlocksRef.current.delete(queuedMessage.id)
          const activeTurnId = lifecycleStore.getTask(address)?.turn.id ?? null
          setMessages(
            appendAcceptedRuntimeConversationMessage(
              address,
              createRuntimeUserMessage(queuedMessage.content, queuedMessage.attachments ?? [], {
                id: queuedMessage.id,
              }),
              activeTurnId,
              turnIdsBeforeSend
            )
          )
          setQueuedMessages(messages => messages.filter(message => message.id !== queuedMessage.id))
          return
        }
        const blockedByBusy = isRuntimeTaskBusyError(sendError)
        if (blockedByBusy) {
          queuedMessageBusyBlocksRef.current.set(queuedMessage.id, lifecycleStore.getTask(address))
          console.info('[Wework] Temporary chat message remains queued while executor is busy', {
            id: queuedMessage.id,
            deviceId: address.deviceId,
            taskId: address.taskId,
          })
        } else {
          queuedMessageBusyBlocksRef.current.delete(queuedMessage.id)
        }
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id !== queuedMessage.id
              ? message
              : blockedByBusy
                ? { ...message, status: 'queued', error: undefined }
                : { ...message, status: 'failed', error: sendError || '发送失败' }
          )
        )
      } catch (caughtError) {
        queuedMessageBusyBlocksRef.current.delete(queuedMessage.id)
        const errorMessage = caughtError instanceof Error ? caughtError.message : '发送失败'
        console.error('[Wework] Temporary chat queued message send failed', {
          id: queuedMessage.id,
          error: caughtError,
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === queuedMessage.id
              ? { ...message, status: 'failed', error: errorMessage }
              : message
          )
        )
      } finally {
        queuedMessageSendInFlightIdsRef.current.delete(queuedMessage.id)
      }
    },
    [address, lifecycleStore, runtimeContext, sendEphemeral, sendRuntimePaneMessage]
  )

  useEffect(() => {
    if (!address || busy) return
    if (queuedMessages.some(message => message.status === 'sending')) return
    const queuedMessage = queuedMessages.find(message => message.status === 'queued')
    if (!queuedMessage) return
    if (
      !consumeRuntimeTaskLifecycleBlock(
        queuedMessageBusyBlocksRef.current,
        queuedMessage.id,
        lifecycleStore.getTask(address)
      )
    ) {
      return
    }
    void sendQueuedMessage(queuedMessage)
  }, [address, busy, lifecycleStore, queuedMessages, sendQueuedMessage])

  const sendQueuedMessageAsGuidance = useCallback(
    async (queuedMessage: RuntimePaneQueuedMessage, forceActiveTurn = false): Promise<boolean> => {
      if (!address || queuedMessage.status === 'sending') return false
      if (!busy && !forceActiveTurn) {
        await sendQueuedMessage(queuedMessage)
        return true
      }

      const sendingMessages = queuedMessagesRef.current.map(message =>
        message.id === queuedMessage.id
          ? {
              ...message,
              status: 'sending' as const,
              deliveryMode: 'guidance' as const,
              error: undefined,
              notice: '正在引导当前对话',
            }
          : message
      )
      queuedMessagesRef.current = sendingMessages
      queuedMessageBusyBlocksRef.current.delete(queuedMessage.id)
      setQueuedMessages(sendingMessages)
      const messageAttachments = queuedMessage.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const result = await sendRuntimePaneGuidance({
        address,
        message: queuedMessage.content,
        clientGuidanceId: queuedMessage.id,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      if (result.sent) return true

      const failedMessages = queuedMessagesRef.current.map(message =>
        message.id === queuedMessage.id
          ? {
              ...message,
              status: 'failed' as const,
              deliveryMode: undefined,
              notice: undefined,
              error: result.error || '引导发送失败',
            }
          : message
      )
      queuedMessagesRef.current = failedMessages
      setQueuedMessages(failedMessages)
      return false
    },
    [address, busy, sendQueuedMessage, sendRuntimePaneGuidance]
  )

  const send = useCallback(
    async (valueOverride?: string, options: ChatSubmitOptions = {}): Promise<boolean> => {
      const message = (valueOverride ?? input).trim()
      if (!message) return false
      if (taskModelIdentityPending) {
        setError('正在同步任务模型配置，请稍后重试')
        return false
      }
      setError(null)
      setInput('')

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
      if (address && busy) {
        const pendingMessages = [...queuedMessagesRef.current, queuedMessage]
        queuedMessagesRef.current = pendingMessages
        setQueuedMessages(pendingMessages)
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
        setInput(current => current || message)
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
          updateAddress(nextAddress)
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
        setInput(current => current || message)
        updateAddress(null)
        setSending(false)
        return false
      }
      if (!address) {
        setMessages(getRuntimeConversationMessages(targetAddress))
        updateAddress(targetAddress)
        setGoalDraftActive(false)
        sideChatProjectChat.resetAttachments()
        return true
      }

      setMessages(
        applyRuntimeConversationAction(targetAddress, {
          type: 'user_added',
          message: createRuntimeUserMessage(message, currentAttachments, {
            id: queuedMessage.id,
          }),
        })
      )
      let sendError: string | null = null
      const sent = await sendRuntimePaneMessage(
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
        }
      )
      if (sent) {
        sideChatProjectChat.resetAttachments()
        return true
      }
      setMessages(
        removeRuntimeConversationTurn(targetAddress, {
          clientUserMessageId: queuedMessage.id,
        })
      )
      if (isRuntimeTaskBusyError(sendError)) {
        queuedMessageBusyBlocksRef.current.set(
          queuedMessage.id,
          lifecycleStore.getTask(targetAddress)
        )
        const pendingMessages = [...queuedMessagesRef.current, queuedMessage]
        queuedMessagesRef.current = pendingMessages
        setQueuedMessages(pendingMessages)
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
    [
      address,
      goalDraftActive,
      createTask,
      createTemporaryRuntimeTask,
      currentProject,
      input,
      busy,
      lifecycleStore,
      queuedMessages.length,
      sideChatProjectChat,
      selectedModelFields,
      runtimeContext,
      sendQueuedMessageAsGuidance,
      sendRuntimePaneMessage,
      source,
      sendEphemeral,
      taskModelIdentityPending,
      updateAddress,
    ]
  )

  useEffect(() => {
    if (!autoSubmitInitialInput || !initialInput.trim() || autoSubmittedInitialInputRef.current) {
      return
    }
    if (taskModelIdentityPending) return
    const timeoutId = window.setTimeout(() => {
      if (autoSubmittedInitialInputRef.current) return
      autoSubmittedInitialInputRef.current = true
      void send(initialInput)
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [autoSubmitInitialInput, initialInput, send, taskModelIdentityPending])

  const cancelQueuedMessage = useCallback((id: string) => {
    queuedMessageBusyBlocksRef.current.delete(id)
    setQueuedMessages(messages =>
      messages.filter(message => message.id !== id || message.status === 'sending')
    )
  }, [])

  const editQueuedMessage = useCallback(
    (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending') return
      queuedMessageBusyBlocksRef.current.delete(id)
      setInput(queuedMessage.content)
      sideChatProjectChat.resetAttachments()
      queuedMessage.attachments?.forEach(sideChatProjectChat.addExistingAttachment)
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [queuedMessages, sideChatProjectChat]
  )

  const guideQueuedMessage = useCallback(
    (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage) return
      void sendQueuedMessageAsGuidance(queuedMessage, true)
    },
    [queuedMessages, sendQueuedMessageAsGuidance]
  )

  const pause = useCallback(() => {
    if (!address) return
    void cancelRuntimePaneTask(address, {
      onError: message => setError(message),
    }).finally(() => setSending(false))
  }, [address, cancelRuntimePaneTask])

  return (
    <section data-testid={testId} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-sm text-text-muted">
          <MessageCircle className="h-5 w-5 text-text-secondary" />
          <p>{emptyStateText}</p>
        </div>
      ) : (
        <ScrollableMessageArea
          messages={messages}
          isWaitingForAssistant={busy}
          devices={state.devices}
          conversationKey={address?.taskId ?? instanceId}
          className="min-h-0 flex-1"
          messageListClassName={`${DESKTOP_MESSAGE_LIST_CLASS} pb-4 pt-5`}
          scrollTestId="right-workspace-chat-scroll-area"
          onLoadFullTranscript={loadFullTranscript}
          loadingFullTranscript={loadingFullTranscript}
        />
      )}
      <div
        data-testid="right-workspace-chat-composer-shell"
        className={cn(
          'shrink-0',
          expanded
            ? cn(
                'relative z-critical mx-auto max-w-[calc(100%_-_2rem)] bg-transparent pb-2 pt-6',
                wideComposer
                  ? 'w-[min(68rem,calc(100%_-_2rem))]'
                  : 'w-[min(46rem,calc(100%_-_2rem))]'
              )
            : 'bg-background py-3'
        )}
      >
        {expanded && onRestoreConversation ? (
          <button
            type="button"
            data-testid="restore-conversation-from-expanded-workspace-button"
            className="mb-1 flex h-8 w-full items-center justify-between rounded-xl border border-border/45 bg-background/95 px-4 text-xs text-text-secondary shadow-sm hover:bg-muted hover:text-text-primary"
            onClick={onRestoreConversation}
          >
            <span>{t('workbench.latest_conversation_turn')}</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        <div
          data-testid="side-chat-composer-layout"
          className={cn('pointer-events-auto', !expanded && DESKTOP_CHAT_CONTENT_WIDTH_CLASS)}
        >
          <BufferedChatInput
            value={input}
            onChange={setInput}
            onDraftEdit={() => setError(null)}
            onSubmit={send}
            disabled={taskModelIdentityPending}
            pluginPickerIconOnly
            error={error}
            placeholder={placeholder}
            variant="desktop"
            collapseWhenIdle={collapseComposerWhenIdle}
            projectChat={sideChatProjectChat}
            projectWork={projectWork}
            showProjectWorkBar={showProjectWorkBar}
            projectWorkBarMiddleContext={projectWorkBarMiddleContext}
            projectWorkBarTrailingContext={projectWorkBarTrailingContext}
            queuedMessages={queuedMessages}
            onCancelQueuedMessage={cancelQueuedMessage}
            onSendQueuedAsGuidance={guideQueuedMessage}
            onEditQueuedMessage={editQueuedMessage}
            isStreaming={busy}
            onPause={pause}
            goalDraftActive={goalDraftActive}
            onSetGoal={
              allowInitialGoal && createTask && !address
                ? () => {
                    setGoalDraftActive(true)
                    setError(null)
                  }
                : undefined
            }
            onCancelGoalDraft={() => setGoalDraftActive(false)}
          />
        </div>
      </div>
    </section>
  )
}
