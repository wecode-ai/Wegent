import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import type {
  Attachment,
  ProjectWithTasks,
  RuntimeTaskAddress,
  TurnFileChangesSummary,
} from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { reduceWorkbenchMessages } from '@wegent/chat-core'

const SIDE_CHAT_MESSAGE_LIST_CLASS = 'w-full max-w-none px-5 pb-4 pt-5 lg:pl-14'

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
}

export function TemporaryChatPanel({
  currentProject,
  source,
  instanceId,
  testId = 'right-workspace-chat-panel',
  initialInput = '',
}: TemporaryChatPanelProps) {
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
  const [address, setAddress] = useState<RuntimeTaskAddress | null>(null)
  const [messages, setMessages] = useState<WorkbenchMessage[]>([])
  const [input, setInput] = useState(initialInput)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [loadingFullTranscript, setLoadingFullTranscript] = useState(false)
  const pendingMessageActionsRef = useRef<RuntimePaneMessageAction[]>([])
  const messageActionFrameRef = useRef<number | null>(null)

  useEffect(() => {
    if (!initialInput) return
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-testid="${testId}"] [data-testid="chat-message-input"]`)
        ?.focus()
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
        if (!cancelled && transcript.messages.length > 0) {
          setMessages(transcript.messages)
        }
      })
      .catch(caughtError => {
        if (!cancelled) {
          setError(caughtError instanceof Error ? caughtError.message : '加载临时聊天失败')
        }
      })
    return () => {
      cancelled = true
    }
  }, [address, loadRuntimeTranscriptForPane])

  const loadFullTranscript = useCallback(async () => {
    if (!address || loadingFullTranscript) return
    setLoadingFullTranscript(true)
    try {
      const transcript = await loadRuntimeTranscriptForPane(address, {
        includeFullContent: true,
        refresh: true,
      })
      if (transcript.messages.length > 0) {
        setMessages(transcript.messages)
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '加载完整输出失败')
    } finally {
      setLoadingFullTranscript(false)
    }
  }, [address, loadRuntimeTranscriptForPane, loadingFullTranscript])

  useEffect(() => {
    if (!address) return
    return subscribeRuntimeTaskStream(address, {
      onMessageAction: dispatchMessages,
      onAssistantStart: () => setSending(true),
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
      setSending(true)

      const currentAttachments = sideChatProjectChat.attachments
      const attachmentIds = remoteAttachmentIds(currentAttachments)
      const attachments = localRuntimeAttachments(currentAttachments)
      const handleError = (message: string) => {
        setError(message)
        setSending(false)
      }

      const targetAddress =
        address ??
        (await createTemporaryRuntimeTask(message, {
          project: currentProject,
          source,
          attachments: currentAttachments,
          onError: handleError,
        }))

      if (!targetAddress) return
      if (!address) {
        setAddress(targetAddress)
        sideChatProjectChat.resetAttachments()
        return
      }

      const sent = await sendRuntimePaneMessage(
        {
          address: targetAddress,
          message,
          ephemeral: true,
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
      createTemporaryRuntimeTask,
      currentProject,
      input,
      sideChatProjectChat,
      selectedModelFields,
      sendRuntimePaneMessage,
      source,
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
          <p>临时聊天不会出现在左侧任务列表。</p>
        </div>
      ) : (
        <ScrollableMessageArea
          messages={messages}
          isWaitingForAssistant={sending}
          devices={state.devices}
          conversationKey={address?.taskId ?? instanceId}
          className="min-h-0 flex-1"
          messageListClassName={SIDE_CHAT_MESSAGE_LIST_CLASS}
          scrollTestId="right-workspace-chat-scroll-area"
          onLoadFullTranscript={loadFullTranscript}
          loadingFullTranscript={loadingFullTranscript}
        />
      )}
      <div className="shrink-0 bg-background px-4 py-3">
        <BufferedChatInput
          value={input}
          onChange={setInput}
          onSubmit={send}
          disabled={false}
          error={error}
          placeholder="要求后续变更"
          variant="desktop"
          projectChat={sideChatProjectChat}
          showProjectWorkBar={false}
          isStreaming={sending}
          onPause={pause}
        />
      </div>
    </section>
  )
}
