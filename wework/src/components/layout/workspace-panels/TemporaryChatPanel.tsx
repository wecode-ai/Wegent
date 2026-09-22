import {
  createPluginTrialGuide,
  type PluginTrialGuide,
} from '@wegent/chat-core/composer-plugin-trial'
import { runtimePaneQueue } from './runtimePaneQueues'
import { ComposerCatalogContext } from '@/components/chat/composer/ComposerCatalogContext'
import { useTaskComposerCatalog } from './useTaskComposerCatalog'
import { resolveLocalWorkbenchDeviceId } from '@/lib/workbench-device'
import {
  runtimeQueuedMessageRequest,
  type RuntimeConversationQueuePort,
} from '@wegent/collaboration/execution/runtimeConversationQueue'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { TemporaryConversationLayout } from '@wegent/collaboration/conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import {
  applyRequestUserInputResponseToBlock,
  requestUserInputPayloadKey,
  requestUserInputResponseText,
} from '@/components/chat/requestUserInputMessages'
import type { ChatSubmitOptions, ProjectWorkControls } from '@/components/chat/ChatInput'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { retryRuntimeConversation } from '@wegent/collaboration/execution/retryRuntimeConversation'
import { DESKTOP_MESSAGE_LIST_CLASS } from '@/components/layout/desktopChatLayout'
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
  getRuntimeConversationTurns,
  getRuntimeConversationTurnIds,
  removeRuntimeConversationTurn,
  subscribeRuntimeConversation,
  updateRuntimeConversationBlocks,
} from '@/features/workbench/runtimeConversationCache'
import {
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { createRuntimeContextUsageStore } from '@wegent/chat-core/runtime-context-usage'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { persistAttachmentReferences } from '@/lib/attachments'
import { focusComposerAtEnd } from '@/lib/workbenchComposerFocus'
import { runtimeGoalCreateInput } from '@/lib/runtime-goal'
import { createAppliedRuntimeGuidanceMessage } from '@/features/workbench/runtimeGuidanceMessages'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  Attachment,
  ModelOptions,
  ModelType,
  ProjectWithTasks,
  RequestUserInputResponse,
  RuntimeSendRequest,
  RuntimeGoalCreateInput,
  RuntimeTaskAddress,
  UnifiedModel,
} from '@/types/api'
import type {
  RuntimeConversationTurn,
  RuntimePaneQueuedMessage,
  WorkbenchMessage,
} from '@/types/workbench'

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
  initialScrollPosition?: 'restore' | 'latest'
  scrollOrigin?: 'top' | 'bottom'
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
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
  initialScrollPosition = 'restore',
  scrollOrigin = 'bottom',
  onOpenRuntimeTask,
}: TemporaryChatPanelProps) {
  const { t, i18n } = useTranslation('common')
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  const conversationTranslate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const {
    services,
    state,
    projectChat,
    createTemporaryRuntimeTask,
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage,
    sendRuntimePaneGuidance,
    cancelRuntimePaneTask,
    subscribeRuntimeTaskStream,
    loadRuntimeTranscriptForPane,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
  } = useWorkbenchPaneContext()
  const attachmentSelection = useWorkbenchAttachments({
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
    scopeKey: instanceId,
  })
  const [address, setAddress] = useState<RuntimeTaskAddress | null>(initialAddress)
  const catalogTranslate = useCallback((key: string) => String(t(key)), [t])
  const catalogAddress = address ?? source
  const catalogDeviceId = resolveLocalWorkbenchDeviceId(state.devices, catalogAddress?.deviceId)
  const composerCatalog = useTaskComposerCatalog(
    catalogAddress && catalogDeviceId ? { ...catalogAddress, deviceId: catalogDeviceId } : null,
    services,
    catalogTranslate
  )
  const contextUsageStore = useMemo(
    () => createRuntimeContextUsageStore(),
    // Each task needs a fresh store; the factory itself has no dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address?.deviceId, address?.taskId]
  )
  const contextUsage = useSyncExternalStore(
    contextUsageStore.subscribe,
    contextUsageStore.getSnapshot,
    contextUsageStore.getSnapshot
  )
  const taskModelSelection = address ? projectChat.resolveRuntimeTaskModelSelection(address) : null
  const globalSelectedModel = projectChat.getSelectedModel?.() ?? projectChat.selectedModel
  const globalSelectedModelOptions =
    projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
  const taskModelIdentityPending = Boolean(
    address &&
    !taskModelSelection?.taskSelection &&
    (state.isBootstrapping || state.runtimeWork === null)
  )
  const [trialGuide, setTrialGuide] = useState<PluginTrialGuide | null>(null)
  const sideChatProjectChat = useMemo(
    () => ({
      ...projectChat,
      scopeKey: instanceId,
      trialTemplates: trialGuide?.templates ?? [],
      trialPluginName: trialGuide?.pluginName,
      trialPluginApp: trialGuide?.app,
      showTrialGuide: (title: string, app: import('@/types/api').LocalDeviceApp) =>
        setTrialGuide(createPluginTrialGuide(title, app.trialTemplates, app)),
      dismissTrialGuide: () => setTrialGuide(null),
      onDismissTrialGuide: undefined,
      onRefineTrialPrompt: undefined,
      contextUsage: contextUsage ?? undefined,
      ...(address && taskModelSelection
        ? {
            activeModel: taskModelSelection.activeModel,
            selectedModel: taskModelSelection.selectedModel,
            selectedModelOptions: taskModelSelection.selectedModelOptions,
            setSelectedModel: (model: UnifiedModel | null) =>
              projectChat.setRuntimeTaskSelectedModel(address, model),
            setSelectedModelAndOptions: (model: UnifiedModel, options: ModelOptions) =>
              projectChat.setRuntimeTaskSelectedModelAndOptions(address, model, options),
            continueInNewConversation: (
              model: UnifiedModel,
              options?: ModelOptions,
              source?: { draft?: string }
            ) =>
              projectChat.continueInNewConversation?.(model, options, {
                ...source,
                address,
              }),
            setSelectedModelOption: (optionId: string, value: string) =>
              projectChat.setRuntimeTaskSelectedModelOption(address, optionId, value),
            getSelectedModel: () =>
              projectChat.resolveRuntimeTaskModelSelection(address).selectedModel,
            getSelectedModelOptions: () =>
              projectChat.resolveRuntimeTaskModelSelection(address).selectedModelOptions,
          }
        : {}),
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
    [
      address,
      attachmentSelection,
      contextUsage,
      projectChat,
      taskModelSelection,
      instanceId,
      trialGuide,
    ]
  )
  const [messages, setMessages] = useState<WorkbenchMessage[]>(() =>
    initialAddress ? getRuntimeConversationMessages(initialAddress) : []
  )
  const [turns, setTurns] = useState<RuntimeConversationTurn[]>(() =>
    initialAddress ? getRuntimeConversationTurns(initialAddress) : []
  )
  const [input, setInput] = useState(initialInput)
  const [error, setError] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(Boolean(initialAddress && !sendEphemeral))
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [sending, setSending] = useState(false)
  const [goalDraftActive, setGoalDraftActive] = useState(false)
  const lifecycleStore = useRuntimeTaskLifecycleStore()
  const conversationQueue = runtimePaneQueue(lifecycleStore, address, instanceId)
  const queuedMessages = useSyncExternalStore(
    conversationQueue.subscribe,
    conversationQueue.getSnapshot,
    conversationQueue.getSnapshot
  )
  const [hiddenRequestUserInputIds, setHiddenRequestUserInputIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
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
  const createdAddressKeyRef = useRef<string | null>(null)
  const autoSubmittedInitialInputRef = useRef(false)
  const retryInFlightRef = useRef(false)

  useEffect(() => {
    conversationQueue.reconcileGuidance(
      new Set(
        messages
          .filter(message => message.role === 'user' && message.runtimeGuidance)
          .map(message => message.id)
      )
    )
  }, [conversationQueue, messages])

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
      setTurns(getRuntimeConversationTurns(address))
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
    setHistoryLoading(true)
    setHistoryError(null)
    const usageRevision = contextUsageStore.getRevision()
    void loadRuntimeTranscriptForPane(address)
      .then(transcript => {
        if (cancelled) {
          abortRuntimeConversationHydration(address, hydrationToken)
          return
        }
        contextUsageStore.receiveTranscript(transcript.contextUsage, usageRevision)
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
          setHistoryError(caughtError instanceof Error ? caughtError.message : String(caughtError))
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
      abortRuntimeConversationHydration(address, hydrationToken)
    }
  }, [
    address,
    contextUsageStore,
    lifecycleStore,
    loadRuntimeTranscriptForPane,
    sendEphemeral,
    historyRevision,
  ])

  useEffect(() => {
    if (!address) return
    return subscribeRuntimeTaskStream(address, {
      onContextUsageUpdated: contextUsageStore.receiveLive,
      onMessageAction: () => undefined,
      onAssistantStart: () => setSending(false),
      onAssistantSettled: () => setSending(false),
      onGuidanceApplied: payload => {
        const guidanceMessage = conversationQueue.applyGuidance(payload)
        if (!guidanceMessage) return
        setMessages(current => [
          ...current.filter(message => message.id !== guidanceMessage.id),
          createAppliedRuntimeGuidanceMessage(guidanceMessage, payload),
        ])
      },
    })
  }, [address, contextUsageStore, subscribeRuntimeTaskStream, conversationQueue])

  const selectedModelFields = useMemo(() => {
    if (address && taskModelSelection) {
      if (taskModelSelection.selectedModel) {
        return selectedModelExecutionFields(
          taskModelSelection.selectedModel,
          taskModelSelection.selectedModelOptions
        )
      }
      if (taskModelSelection.taskSelection?.modelName) {
        return {
          modelId: taskModelSelection.taskSelection.modelName,
          modelType: taskModelSelection.taskSelection.modelType,
          modelOptions: taskModelSelection.selectedModelOptions,
        }
      }
    }
    return selectedModelExecutionFields(globalSelectedModel, globalSelectedModelOptions)
  }, [address, globalSelectedModel, globalSelectedModelOptions, taskModelSelection])

  useEffect(() => {
    if (!address) return
    console.info('[runtime-v2] task conversation identity resolved', {
      deviceId: address.deviceId,
      taskId: address.taskId,
      taskModel: taskModelSelection?.taskSelection?.modelName ?? null,
      taskModelType: taskModelSelection?.taskSelection?.modelType ?? null,
      resolvedCatalogModel: taskModelSelection?.activeModel?.name ?? null,
      globalComposerModel: globalSelectedModel?.name ?? null,
    })
  }, [address, globalSelectedModel, taskModelSelection])

  const queuePort = useMemo<RuntimeConversationQueuePort<number>>(
    () => ({
      lifecycle: () => lifecycleStore.getTaskRevision(address),
      lifecycleChanged: previous => previous !== lifecycleStore.getTaskRevision(address),
      isBusyError: isRuntimeTaskBusyError,
      sendFailedText: t('workbench.project_chat_send_failed'),
      guidanceFailedText: t('workbench.project_chat_send_failed'),
      async send(message) {
        if (!address) return { sent: false, error: t('workbench.project_chat_send_failed') }
        const turnIdsBeforeSend = getRuntimeConversationTurnIds(address)
        let error: string | null = null
        const sent = await sendRuntimePaneMessage(
          runtimeQueuedMessageRequest(
            { address, ...(sendEphemeral ? { ephemeral: true } : {}), ...runtimeContext },
            message
          ),
          {
            onError: value => {
              error = value
            },
          }
        )
        if (sent)
          setMessages(
            appendAcceptedRuntimeConversationMessage(
              address,
              createRuntimeUserMessage(message.content, message.attachments ?? [], {
                id: message.id,
              }),
              lifecycleStore.getTask(address)?.turn.id ?? null,
              turnIdsBeforeSend
            )
          )
        return { sent, error }
      },
      async guide(message) {
        if (!address) return { sent: false, error: t('workbench.project_chat_send_failed') }
        const request = runtimeQueuedMessageRequest({ address }, message)
        return sendRuntimePaneGuidance({
          address,
          message: request.message,
          clientGuidanceId: message.id,
          ...(request.attachmentIds ? { attachmentIds: request.attachmentIds } : {}),
          ...(request.attachments ? { attachments: request.attachments } : {}),
        })
      },
    }),
    [
      address,
      lifecycleStore,
      runtimeContext,
      sendEphemeral,
      sendRuntimePaneMessage,
      sendRuntimePaneGuidance,
      t,
    ]
  )

  useEffect(() => {
    if (address) void conversationQueue.pump(queuePort, busy)
  }, [address, busy, taskLifecycle, queuedMessages, conversationQueue, queuePort])

  const sendQueuedMessageAsGuidance = useCallback(
    (message: RuntimePaneQueuedMessage, forceActiveTurn = false) =>
      conversationQueue.guide(
        message.id,
        queuePort,
        forceActiveTurn || Boolean(address && lifecycleStore.getTask(address)?.derived.isTurnActive)
      ),
    [address, conversationQueue, lifecycleStore, queuePort]
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
        setSending(false)
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
      const sendMessage =
        busy && options.interruptWhenBusy
          ? interruptAndSendRuntimePaneMessage
          : sendRuntimePaneMessage
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
        }
      )
      if (sent) {
        sideChatProjectChat.resetAttachments()
        setSending(false)
        return true
      }
      setMessages(
        removeRuntimeConversationTurn(targetAddress, {
          clientUserMessageId: queuedMessage.id,
        })
      )
      if (isRuntimeTaskBusyError(sendError)) {
        conversationQueue.enqueue(queuedMessage, {
          value: lifecycleStore.getTaskRevision(targetAddress),
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
    [
      address,
      goalDraftActive,
      createTask,
      createTemporaryRuntimeTask,
      currentProject,
      input,
      busy,
      queuedMessages.length,
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

  const cancelQueuedMessage = useCallback(
    (id: string) => conversationQueue.cancel(id),
    [conversationQueue]
  )

  const editQueuedMessage = useCallback(
    (id: string) => {
      const message = conversationQueue.take(id)
      if (!message) return
      setInput(message.content)
      sideChatProjectChat.resetAttachments()
      message.attachments?.forEach(sideChatProjectChat.addExistingAttachment)
    },
    [conversationQueue, sideChatProjectChat]
  )

  const guideQueuedMessage = useCallback(
    (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage) return
      void sendQueuedMessageAsGuidance(queuedMessage)
    },
    [queuedMessages, sendQueuedMessageAsGuidance]
  )

  const pause = useCallback(() => {
    if (!address) return
    void cancelRuntimePaneTask(address, {
      onError: message => setError(message),
    }).finally(() => setSending(false))
  }, [address, cancelRuntimePaneTask])

  const openRuntimeTask = useCallback(() => {
    if (!address || !onOpenRuntimeTask) return
    void onOpenRuntimeTask(address)
  }, [address, onOpenRuntimeTask])

  const retryFailedMessage = useCallback(
    async (message: WorkbenchMessage): Promise<boolean> => {
      if (!address || retryInFlightRef.current) return false
      retryInFlightRef.current = true
      setError(null)
      try {
        await retryRuntimeConversation({
          messageId: message.id,
          messages,
          request: { address, ...selectedModelFields, ...runtimeContext },
          labels: {
            continue: t('workbench.retry_continue_message'),
            missing: t('workbench.retry_message_missing'),
            failed: t('workbench.retry_failed'),
          },
          addUserMessage: message =>
            setMessages(applyRuntimeConversationAction(address, { type: 'user_added', message })),
          removeUserMessage: clientUserMessageId =>
            setMessages(removeRuntimeConversationTurn(address, { clientUserMessageId })),
          send: sendRuntimePaneMessage,
        })
        return true
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : t('workbench.retry_failed'))
        return false
      } finally {
        retryInFlightRef.current = false
      }
    },
    [address, messages, runtimeContext, selectedModelFields, sendRuntimePaneMessage, t]
  )

  const submitRequestUserInput = useCallback(
    async (response: RequestUserInputResponse): Promise<boolean> => {
      if (!address) return false
      const sent = await sendRuntimePaneMessage({
        address,
        message: requestUserInputResponseText(response),
        requestUserInputResponse: response,
        ...runtimeContext,
      })
      if (!sent) return false
      setMessages(
        updateRuntimeConversationBlocks(address, block =>
          applyRequestUserInputResponseToBlock(block, response)
        )
      )
      return true
    },
    [address, runtimeContext, sendRuntimePaneMessage]
  )

  const ignoreRequestUserInput = useCallback(
    async (payload: RequestUserInputPayload) => {
      if (!address) return
      const key = requestUserInputPayloadKey(payload)
      if (key) {
        setHiddenRequestUserInputIds(current => new Set(current).add(key))
      }
      const cancelled = await cancelRuntimePaneTask(address)
      if (!cancelled && key) {
        setHiddenRequestUserInputIds(current => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    },
    [address, cancelRuntimePaneTask]
  )

  return (
    <TemporaryConversationLayout
      messageCount={messages.length}
      loading={historyLoading}
      loadError={historyError}
      onRetry={() => setHistoryRevision(value => value + 1)}
      testId={testId}
      emptyStateText={emptyStateText}
      expanded={expanded}
      wideComposer={wideComposer}
      onRestoreConversation={onRestoreConversation}
      translate={conversationTranslate}
      composer={
        <ComposerCatalogContext.Provider value={composerCatalog}>
          <BufferedChatInput
            value={input}
            onChange={setInput}
            onDraftEdit={() => setError(null)}
            onSubmit={send}
            disabled={taskModelIdentityPending}
            pluginPickerIconOnly
            requireText
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
        </ComposerCatalogContext.Provider>
      }
    >
      <ScrollableMessageArea
        messages={messages}
        turns={turns}
        isWaitingForAssistant={busy}
        devices={state.devices}
        conversationKey={address?.taskId ?? instanceId}
        className="min-h-0 flex-1"
        contentClassName="min-h-full shrink-0"
        messageListClassName={`${DESKTOP_MESSAGE_LIST_CLASS} pb-4 pt-5`}
        scrollTestId="right-workspace-chat-scroll-area"
        onRetryFailedMessage={
          address
            ? message => {
                void retryFailedMessage(message)
              }
            : undefined
        }
        onSwitchModelForFailedMessage={onOpenRuntimeTask ? openRuntimeTask : undefined}
        onLoadFileChangesDiff={
          address
            ? (subtaskId, fileChanges) =>
                loadTurnFileChangesDiff(subtaskId, messages, fileChanges, address)
            : undefined
        }
        onRevertFileChanges={
          address
            ? (subtaskId, fileChanges) =>
                revertTurnFileChanges(subtaskId, messages, fileChanges, address)
            : undefined
        }
        onOpenFileChangesReview={onOpenRuntimeTask ? openRuntimeTask : undefined}
        onOpenWorkspaceFile={onOpenRuntimeTask ? openRuntimeTask : undefined}
        onOpenLocalSkillFile={onOpenRuntimeTask ? openRuntimeTask : undefined}
        onRequestUserInputSubmit={address ? submitRequestUserInput : undefined}
        onRequestUserInputIgnore={address ? ignoreRequestUserInput : undefined}
        onOpenAssistantPlan={onOpenRuntimeTask ? openRuntimeTask : undefined}
        hiddenRequestUserInputIds={hiddenRequestUserInputIds}
        initialScrollPosition={initialScrollPosition}
        scrollOrigin={scrollOrigin}
      />
    </TemporaryConversationLayout>
  )
}
