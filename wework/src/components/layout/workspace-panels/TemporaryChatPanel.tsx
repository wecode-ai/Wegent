import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, MessageCircle } from 'lucide-react'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import {
  DESKTOP_CHAT_CONTENT_WIDTH_CLASS,
  DESKTOP_MESSAGE_LIST_CLASS,
} from '@/components/layout/desktopChatLayout'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { deriveRuntimePaneStatus } from '@/features/workbench/runtimePaneStatus'
import {
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { focusComposerAtEnd } from '@/lib/workbenchComposerFocus'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  Attachment,
  ProjectWithTasks,
  RuntimeTaskAddress,
  TurnFileChangesSummary,
} from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { reduceWorkbenchMessages } from '@wegent/chat-core'

function isBatchableRuntimePaneMessageAction(action: RuntimePaneMessageAction): boolean {
  return action.type === 'assistant_chunk' || action.type === 'block_updated'
}

function createUserMessage(content: string): WorkbenchMessage {
  const createdAt = new Date().toISOString()
  return {
    id: `side-user-${Date.now()}`,
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
  const [messages, setMessages] = useState<WorkbenchMessage[]>([])
  const [input, setInput] = useState(initialInput)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
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
  const pendingMessageActionsRef = useRef<RuntimePaneMessageAction[]>([])
  const messageActionFrameRef = useRef<number | null>(null)

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

  const applyMessageActions = useCallback((actions: RuntimePaneMessageAction[]) => {
    if (actions.length === 0) return
    setMessages(current => {
      let nextMessages = current
      for (const action of actions) {
        nextMessages = reduceWorkbenchMessages<Attachment, TurnFileChangesSummary>(
          nextMessages,
          action
        )
      }
      return nextMessages
    })
  }, [])

  const flushPendingMessageActions = useCallback(() => {
    if (messageActionFrameRef.current !== null) {
      cancelAnimationFrame(messageActionFrameRef.current)
      messageActionFrameRef.current = null
    }
    const pendingActions = pendingMessageActionsRef.current
    if (pendingActions.length === 0) return
    pendingMessageActionsRef.current = []
    applyMessageActions(pendingActions)
  }, [applyMessageActions])

  const dispatchMessages = useCallback(
    (action: RuntimePaneMessageAction) => {
      if (!isBatchableRuntimePaneMessageAction(action)) {
        flushPendingMessageActions()
        applyMessageActions([action])
        return
      }

      pendingMessageActionsRef.current.push(action)
      if (messageActionFrameRef.current !== null) return
      messageActionFrameRef.current = requestAnimationFrame(() => {
        messageActionFrameRef.current = null
        const pendingActions = pendingMessageActionsRef.current
        if (pendingActions.length === 0) return
        pendingMessageActionsRef.current = []
        applyMessageActions(pendingActions)
      })
    },
    [applyMessageActions, flushPendingMessageActions]
  )

  useEffect(() => {
    return () => {
      if (messageActionFrameRef.current !== null) {
        cancelAnimationFrame(messageActionFrameRef.current)
        messageActionFrameRef.current = null
      }
      pendingMessageActionsRef.current = []
    }
  }, [])

  useEffect(() => {
    if (!address) return
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
  }, [address, lifecycleStore, loadRuntimeTranscriptForPane])

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
      onMessageAction: dispatchMessages,
      onAssistantStart: () => setSending(false),
      onAssistantSettled: () => setSending(false),
    })
  }, [address, dispatchMessages, subscribeRuntimeTaskStream])

  const selectedModelFields = useMemo(() => {
    const selectedModel = projectChat.getSelectedModel?.() ?? projectChat.selectedModel
    const selectedModelOptions =
      projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
    return selectedModelExecutionFields(selectedModel, selectedModelOptions)
  }, [projectChat])

  const send = useCallback(
    async (valueOverride?: string) => {
      const message = (valueOverride ?? input).trim()
      if (!message) return
      setError(null)
      setMessages(current => [...current, createUserMessage(message)])
      setInput('')
      setSending(true)

      const currentAttachments = sideChatProjectChat.attachments
      const attachmentIds = remoteAttachmentIds(currentAttachments)
      const attachments = localRuntimeAttachments(currentAttachments)
      const handleError = (errorMessage: string) => {
        setError(errorMessage)
        setInput(current => current || message)
        setSending(false)
      }

      const targetAddress =
        address ??
        (createTask
          ? await createTask(message, {
              attachments: currentAttachments,
              onError: handleError,
              onRuntimeTaskOptimisticOpen: updateAddress,
            })
          : await createTemporaryRuntimeTask(message, {
              project: currentProject,
              source,
              attachments: currentAttachments,
              onError: handleError,
              onRuntimeTaskOptimisticOpen: updateAddress,
            }))

      if (!targetAddress) {
        setInput(current => current || message)
        updateAddress(null)
        setSending(false)
        return
      }
      if (!address) {
        updateAddress(targetAddress)
        sideChatProjectChat.resetAttachments()
        return
      }

      const sent = await sendRuntimePaneMessage(
        {
          address: targetAddress,
          message,
          ...(sendEphemeral ? { ephemeral: true } : {}),
          ...selectedModelFields,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        { onError: handleError }
      )
      if (sent) {
        sideChatProjectChat.resetAttachments()
      } else {
        setSending(false)
      }
    },
    [
      address,
      createTask,
      createTemporaryRuntimeTask,
      currentProject,
      input,
      sideChatProjectChat,
      selectedModelFields,
      sendRuntimePaneMessage,
      source,
      sendEphemeral,
      updateAddress,
    ]
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
            onSubmit={send}
            disabled={false}
            error={error}
            placeholder={placeholder}
            variant="desktop"
            projectChat={sideChatProjectChat}
            showProjectWorkBar={false}
            isStreaming={busy}
            onPause={pause}
          />
        </div>
      </div>
    </section>
  )
}
