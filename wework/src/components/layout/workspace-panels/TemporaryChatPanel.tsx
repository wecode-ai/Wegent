import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, MessageCircle } from 'lucide-react'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import type { ChatSubmitOptions } from '@/components/chat/ChatInput'
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
  applyRuntimeConversationAction,
  getRuntimeConversationMessages,
  removeRuntimeConversationTurn,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import {
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { persistAttachmentReferences } from '@/lib/attachments'
import { focusComposerAtEnd } from '@/lib/workbenchComposerFocus'
import { createAppliedRuntimeGuidanceMessage } from '@/features/workbench/runtimeGuidanceMessages'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  Attachment,
  ModelOptions,
  ModelType,
  ProjectWithTasks,
  RuntimeTaskAddress,
} from '@/types/api'
import type { RuntimePaneQueuedMessage, WorkbenchMessage } from '@/types/workbench'

const QUEUED_MESSAGE_RETRY_DELAY_MS = 250
const QUEUED_MESSAGE_MAX_BUSY_RETRIES = 40

function createUserMessage(content: string, id = `side-user-${Date.now()}`): WorkbenchMessage {
  const createdAt = new Date().toISOString()
  return {
    id,
    role: 'user',
    content,
    status: 'done',
    createdAt,
  }
}

interface TemporaryChatPanelProps {
  currentProject: ProjectWithTasks | null
  source: RuntimeTaskAddress | null
  instanceId: string
  testId?: string
  initialInput?: string
  initialAddress?: RuntimeTaskAddress | null
  createTask?: (
    message: string,
    options: {
      attachments: Attachment[]
      executionModel: {
        modelId?: string
        modelType?: ModelType | null
        modelOptions?: ModelOptions
      }
      onError: (message: string) => void
      onRuntimeTaskOptimisticOpen: (address: RuntimeTaskAddress) => void
    }
  ) => Promise<RuntimeTaskAddress | false>
  onAddressChange?: (address: RuntimeTaskAddress | null) => void
  sendEphemeral?: boolean
  emptyStateText?: string
  placeholder?: string
  expanded?: boolean
  onRestoreConversation?: () => void
}

export function TemporaryChatPanel({
  currentProject,
  source,
  instanceId,
  testId = 'right-workspace-chat-panel',
  initialInput = '',
  initialAddress = null,
  createTask,
  onAddressChange,
  sendEphemeral = true,
  emptyStateText = '临时聊天不会出现在左侧任务列表。',
  placeholder = '要求后续变更',
  expanded = false,
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
  const sideChatProjectChat = useMemo(
    () => ({
      ...projectChat,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
    }),
    [attachmentSelection, projectChat]
  )
  const [address, setAddress] = useState<RuntimeTaskAddress | null>(initialAddress)
  const [messages, setMessages] = useState<WorkbenchMessage[]>(() =>
    initialAddress ? getRuntimeConversationMessages(initialAddress) : []
  )
  const [input, setInput] = useState(initialInput)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
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
  const queuedMessagesRef = useRef(queuedMessages)
  const createdAddressKeyRef = useRef<string | null>(null)

  useEffect(() => {
    queuedMessagesRef.current = queuedMessages
  }, [queuedMessages])

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
    const syncMessages = () => setMessages(getRuntimeConversationMessages(address))
    return subscribeRuntimeConversation(address, syncMessages)
  }, [address])

  useEffect(() => {
    if (!address || sendEphemeral) return
    if (createdAddressKeyRef.current === `${address.deviceId}:${address.taskId}`) return
    let cancelled = false
    void loadRuntimeTranscriptForPane(address)
      .then(transcript => {
        if (cancelled) return
        lifecycleStore.syncTranscript(address, transcript, {
          preserveActiveTurn: lifecycleStore.getTask(address)?.derived.isRunning ?? false,
        })
        if (transcript.messages.length > 0) setMessages(transcript.messages)
      })
      .catch(caughtError => {
        if (!cancelled) {
          setError(caughtError instanceof Error ? caughtError.message : '加载临时聊天失败')
        }
      })
    return () => {
      cancelled = true
    }
  }, [address, lifecycleStore, loadRuntimeTranscriptForPane, sendEphemeral])

  const loadFullTranscript = useCallback(async () => {
    if (!address || loadingFullTranscript) return
    setLoadingFullTranscript(true)
    try {
      const transcript = await loadRuntimeTranscriptForPane(address, {
        includeFullContent: true,
        refresh: true,
      })
      lifecycleStore.syncTranscript(address, transcript, {
        preserveActiveTurn: lifecycleStore.getTask(address)?.derived.isRunning ?? false,
      })
      if (transcript.messages.length > 0) {
        setMessages(transcript.messages)
      }
    } catch (caughtError) {
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
    const selectedModel = projectChat.getSelectedModel?.() ?? projectChat.selectedModel
    const selectedModelOptions =
      projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
    return selectedModelExecutionFields(selectedModel, selectedModelOptions)
  }, [projectChat])

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
        for (let attempt = 0; attempt <= QUEUED_MESSAGE_MAX_BUSY_RETRIES; attempt += 1) {
          let sendError: string | null = null
          const messageAttachments = queuedMessage.attachments ?? []
          const attachmentIds = remoteAttachmentIds(messageAttachments)
          const attachments = localRuntimeAttachments(messageAttachments)
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
            },
            {
              onError: message => {
                sendError = message
              },
            }
          )
          if (sent) {
            setMessages(
              applyRuntimeConversationAction(address, {
                type: 'user_added',
                message: createUserMessage(queuedMessage.content, queuedMessage.id),
              })
            )
            setQueuedMessages(messages =>
              messages.filter(message => message.id !== queuedMessage.id)
            )
            return
          }
          if (!isRuntimeTaskBusyError(sendError) || attempt === QUEUED_MESSAGE_MAX_BUSY_RETRIES) {
            setQueuedMessages(messages =>
              messages.map(message =>
                message.id === queuedMessage.id
                  ? { ...message, status: 'failed', error: sendError || '发送失败' }
                  : message
              )
            )
            return
          }
          await new Promise(resolve => window.setTimeout(resolve, QUEUED_MESSAGE_RETRY_DELAY_MS))
        }
      } finally {
        queuedMessageSendInFlightIdsRef.current.delete(queuedMessage.id)
      }
    },
    [address, sendEphemeral, sendRuntimePaneMessage]
  )

  useEffect(() => {
    if (!address || busy) return
    if (queuedMessages.some(message => message.status === 'sending')) return
    const queuedMessage = queuedMessages.find(message => message.status === 'queued')
    if (!queuedMessage) return
    void sendQueuedMessage(queuedMessage)
  }, [address, busy, queuedMessages, sendQueuedMessage])

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
      setError(null)
      setInput('')

      const currentAttachments = sideChatProjectChat.attachments
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
        const optimisticUserMessage = createUserMessage(message, queuedMessage.id)
        setMessages(current => [...current, optimisticUserMessage])
        const handleOptimisticOpen = (nextAddress: RuntimeTaskAddress) => {
          optimisticAddress = nextAddress
          createdAddressKeyRef.current = `${nextAddress.deviceId}:${nextAddress.taskId}`
          setMessages(
            applyRuntimeConversationAction(nextAddress, {
              type: 'user_added',
              message: optimisticUserMessage,
            })
          )
          updateAddress(nextAddress)
        }
        targetAddress = createTask
          ? await createTask(message, {
              attachments: currentAttachments,
              executionModel: selectedModelFields,
              onError: handleError,
              onRuntimeTaskOptimisticOpen: handleOptimisticOpen,
            })
          : await createTemporaryRuntimeTask(message, {
              project: currentProject,
              source,
              attachments: currentAttachments,
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
        setMessages(
          applyRuntimeConversationAction(targetAddress, {
            type: 'user_added',
            message: createUserMessage(message, queuedMessage.id),
          })
        )
        updateAddress(targetAddress)
        sideChatProjectChat.resetAttachments()
        return true
      }

      setMessages(
        applyRuntimeConversationAction(targetAddress, {
          type: 'user_added',
          message: createUserMessage(message, queuedMessage.id),
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
      createTask,
      createTemporaryRuntimeTask,
      currentProject,
      input,
      busy,
      queuedMessages.length,
      sideChatProjectChat,
      selectedModelFields,
      sendQueuedMessageAsGuidance,
      sendRuntimePaneMessage,
      source,
      sendEphemeral,
      updateAddress,
    ]
  )

  const cancelQueuedMessage = useCallback((id: string) => {
    setQueuedMessages(messages =>
      messages.filter(message => message.id !== id || message.status === 'sending')
    )
  }, [])

  const editQueuedMessage = useCallback(
    (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending') return
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
    <section data-testid={testId} className="flex min-h-0 flex-1 flex-col">
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
            ? 'relative z-critical mx-auto w-[min(46rem,calc(100%_-_2rem))] max-w-[calc(100%_-_2rem)] bg-transparent pb-2 pt-6'
            : 'bg-background py-3'
        )}
      >
        {expanded && (
          <button
            type="button"
            data-testid="restore-conversation-from-expanded-workspace-button"
            className="mb-1 flex h-8 w-full items-center justify-between rounded-xl border border-border/45 bg-background/95 px-4 text-xs text-text-secondary shadow-sm hover:bg-muted hover:text-text-primary"
            onClick={onRestoreConversation}
          >
            <span>{t('workbench.latest_conversation_turn')}</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <div
          data-testid="side-chat-composer-layout"
          className={cn('pointer-events-auto', !expanded && DESKTOP_CHAT_CONTENT_WIDTH_CLASS)}
        >
          <BufferedChatInput
            value={input}
            onChange={setInput}
            onDraftEdit={() => setError(null)}
            onSubmit={send}
            disabled={false}
            pluginPickerIconOnly
            error={error}
            placeholder={placeholder}
            variant="desktop"
            projectChat={sideChatProjectChat}
            showProjectWorkBar={false}
            queuedMessages={queuedMessages}
            onCancelQueuedMessage={cancelQueuedMessage}
            onSendQueuedAsGuidance={guideQueuedMessage}
            onEditQueuedMessage={editQueuedMessage}
            isStreaming={busy}
            onPause={pause}
          />
        </div>
      </div>
    </section>
  )
}
