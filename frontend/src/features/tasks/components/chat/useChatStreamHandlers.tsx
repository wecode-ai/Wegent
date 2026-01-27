// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTaskContext } from '../../contexts/taskContext'
import { useChatStreamContext, computeIsStreaming } from '../../contexts/chatStreamContext'
import { useSocket } from '@/contexts/SocketContext'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { useTraceAction } from '@/hooks/useTraceAction'
import { parseError, getErrorDisplayMessage } from '@/utils/errorParser'
import { taskApis } from '@/apis/tasks'
import { isChatShell, teamRequiresWorkspace } from '../../service/messageService'
import { Button } from '@/components/ui/button'
import { DEFAULT_MODEL_NAME } from '../selector/ModelSelector'
import type { Model } from '../selector/ModelSelector'
import type { Team, GitRepoInfo, GitBranch, Attachment, SubtaskContextBrief } from '@/types/api'
import type { ContextItem } from '@/types/context'
export interface UseChatStreamHandlersOptions {
  // Team and model
  selectedTeam: Team | null
  selectedModel: Model | null
  forceOverride: boolean

  // Repository
  selectedRepo: GitRepoInfo | null
  selectedBranch: GitBranch | null
  showRepositorySelector: boolean
  /** Effective requires workspace value (considering user override) */
  effectiveRequiresWorkspace?: boolean

  // Input
  taskInputMessage: string
  setTaskInputMessage: (message: string) => void

  // Loading
  setIsLoading: (value: boolean) => void

  // Toggles
  enableDeepThinking: boolean
  enableClarification: boolean

  // External API
  externalApiParams: Record<string, string>

  // Attachment (multi-attachment)
  attachments: Attachment[]
  resetAttachment: () => void
  isAttachmentReadyToSend: boolean

  // Task type
  taskType: 'chat' | 'code' | 'knowledge'

  // Knowledge base ID (for knowledge type tasks)
  knowledgeBaseId?: number

  // UI flags
  shouldHideChatInput: boolean

  // Scroll helper
  scrollToBottom: (force?: boolean) => void

  // Context selection (knowledge bases)
  selectedContexts?: ContextItem[]
  resetContexts?: () => void

  // Callback when a new task is created (used for binding knowledge base)
  onTaskCreated?: (taskId: number) => void

  // Selected document IDs from DocumentPanel (for notebook mode context injection)
  selectedDocumentIds?: number[]
}

export interface ChatStreamHandlers {
  // Stream state
  /** Pending task ID - can be tempTaskId (negative) or taskId (positive) before selectedTaskDetail updates */
  pendingTaskId: number | null
  currentStreamState: ReturnType<typeof useChatStreamContext>['getStreamState'] extends (
    id: number
  ) => infer R
    ? R
    : never
  isStreaming: boolean
  isSubtaskStreaming: boolean
  isStopping: boolean
  hasPendingUserMessage: boolean
  localPendingMessage: string | null

  // Actions
  handleSendMessage: (overrideMessage?: string) => Promise<void>
  /**
   * Send a message with a temporary model override (used for regeneration).
   * @param overrideMessage - The message content to send
   * @param modelOverride - The model to use for this single request
   * @param existingContexts - Optional existing contexts from original message (attachments, knowledge bases, tables)
   */
  handleSendMessageWithModel: (
    overrideMessage: string,
    modelOverride: Model,
    existingContexts?: SubtaskContextBrief[]
  ) => Promise<void>
  handleRetry: (message: {
    content: string
    type: string
    error?: string
    subtaskId?: number
  }) => Promise<void>
  handleCancelTask: () => Promise<void>
  stopStream: () => Promise<void>
  resetStreamingState: () => void

  // Group chat handlers
  handleNewMessages: (messages: unknown[]) => void
  handleStreamComplete: (subtaskId: number, result?: Record<string, unknown>) => void

  // State
  isCancelling: boolean
}

/**
 * useChatStreamHandlers Hook
 *
 * Manages all streaming-related logic for the ChatArea component, including:
 * - Sending messages (via WebSocket)
 * - Stopping streams
 * - Retrying failed messages
 * - Cancelling tasks
 * - Tracking streaming state
 * - Group chat message handling
 *
 * This hook extracts all the complex streaming logic from ChatArea
 * to reduce the component size and improve maintainability.
 */
export function useChatStreamHandlers({
  selectedTeam,
  selectedModel,
  forceOverride,
  selectedRepo,
  selectedBranch,
  showRepositorySelector,
  effectiveRequiresWorkspace,
  taskInputMessage,
  setTaskInputMessage,
  setIsLoading,
  enableDeepThinking,
  enableClarification,
  externalApiParams,
  attachments,
  resetAttachment,
  isAttachmentReadyToSend,
  taskType,
  knowledgeBaseId,
  shouldHideChatInput,
  scrollToBottom,
  selectedContexts = [],
  resetContexts,
  onTaskCreated,
  selectedDocumentIds,
}: UseChatStreamHandlersOptions): ChatStreamHandlers {
  const { toast } = useToast()
  const { t } = useTranslation()
  const { user } = useUser()
  const { traceAction } = useTraceAction()
  const router = useRouter()
  const searchParams = useSearchParams()

  const { selectedTaskDetail, refreshTasks, refreshSelectedTaskDetail, markTaskAsViewed } =
    useTaskContext()

  const {
    getStreamState,
    isTaskStreaming,
    sendMessage: contextSendMessage,
    stopStream: contextStopStream,
    resumeStream: contextResumeStream,
    clearVersion,
  } = useChatStreamContext()

  const { retryMessage } = useSocket()

  // Local state
  const [pendingTaskId, setPendingTaskId] = useState<number | null>(null)
  const [localPendingMessage, setLocalPendingMessage] = useState<string | null>(null)
  const [isCancelling, setIsCancelling] = useState(false)

  // Refs
  const lastFailedMessageRef = useRef<string | null>(null)
  const handleSendMessageRef = useRef<((message?: string) => Promise<void>) | null>(null)
  const previousTaskIdRef = useRef<number | null | undefined>(undefined)
  const prevTaskIdForModelRef = useRef<number | null | undefined>(undefined)
  const prevClearVersionRef = useRef(clearVersion)

  // Unified function to reset streaming-related state
  const resetStreamingState = useCallback(() => {
    setLocalPendingMessage(null)
    setPendingTaskId(null)
  }, [])

  // Get current display task ID
  const currentDisplayTaskId = selectedTaskDetail?.id

  // Get stream state for the currently displayed task
  const currentStreamState = useMemo(() => {
    if (!currentDisplayTaskId) {
      if (pendingTaskId) {
        return getStreamState(pendingTaskId)
      }
      return undefined
    }
    return getStreamState(currentDisplayTaskId)
  }, [currentDisplayTaskId, pendingTaskId, getStreamState])

  // Check streaming states
  const _isStreamingTaskActive = pendingTaskId ? isTaskStreaming(pendingTaskId) : false
  const isContextStreaming = computeIsStreaming(currentStreamState?.messages)

  const isSubtaskStreaming = useMemo(() => {
    if (!selectedTaskDetail?.subtasks) return false
    return selectedTaskDetail.subtasks.some(
      subtask => subtask.role === 'assistant' && subtask.status === 'RUNNING'
    )
  }, [selectedTaskDetail?.subtasks])

  const isStreaming = isSubtaskStreaming || isContextStreaming
  const isStopping = currentStreamState?.isStopping || false

  // Check for pending user messages
  const hasPendingUserMessage = useMemo(() => {
    if (localPendingMessage) return true
    if (!currentStreamState?.messages) return false
    for (const msg of currentStreamState.messages.values()) {
      if (msg.type === 'user' && msg.status === 'pending') return true
    }
    return false
  }, [localPendingMessage, currentStreamState?.messages])

  // Stop stream wrapper
  const stopStream = useCallback(async () => {
    const taskIdToStop = currentDisplayTaskId || pendingTaskId

    if (taskIdToStop && taskIdToStop > 0) {
      const team =
        typeof selectedTaskDetail?.team === 'object' ? selectedTaskDetail.team : undefined
      await contextStopStream(taskIdToStop, selectedTaskDetail?.subtasks, team)
    }
  }, [
    currentDisplayTaskId,
    pendingTaskId,
    contextStopStream,
    selectedTaskDetail?.subtasks,
    selectedTaskDetail?.team,
  ])

  // Group chat handlers
  const handleNewMessages = useCallback(
    (messages: unknown[]) => {
      if (Array.isArray(messages) && messages.length > 0) {
        refreshSelectedTaskDetail()
      }
    },
    [refreshSelectedTaskDetail]
  )

  const handleStreamComplete = useCallback(
    (_subtaskId: number, _result?: Record<string, unknown>) => {
      refreshSelectedTaskDetail()
    },
    [refreshSelectedTaskDetail]
  )

  // Reset state when clearVersion changes (e.g., "New Chat")
  useEffect(() => {
    if (clearVersion !== prevClearVersionRef.current) {
      prevClearVersionRef.current = clearVersion

      setIsLoading(false)
      setLocalPendingMessage(null)
      setPendingTaskId(null)
      previousTaskIdRef.current = undefined
      prevTaskIdForModelRef.current = undefined
      setIsCancelling(false)
    }
  }, [clearVersion, setIsLoading])

  // Clear pendingTaskId when switching to a different task
  useEffect(() => {
    if (pendingTaskId && selectedTaskDetail?.id && selectedTaskDetail.id !== pendingTaskId) {
      setPendingTaskId(null)
    }
  }, [selectedTaskDetail?.id, pendingTaskId])

  // Reset when navigating to fresh new task state
  useEffect(() => {
    if (!selectedTaskDetail?.id && !pendingTaskId) {
      resetStreamingState()
      setIsLoading(false)
    }
  }, [selectedTaskDetail?.id, pendingTaskId, resetStreamingState, setIsLoading])

  // Reset when switching to a DIFFERENT task
  useEffect(() => {
    const currentTaskId = selectedTaskDetail?.id
    const previousTaskId = previousTaskIdRef.current

    if (
      previousTaskId !== undefined &&
      currentTaskId !== previousTaskId &&
      previousTaskId !== null
    ) {
      resetStreamingState()
    }

    previousTaskIdRef.current = currentTaskId
  }, [selectedTaskDetail?.id, resetStreamingState])

  // Try to resume streaming on task change
  useEffect(() => {
    const taskId = selectedTaskDetail?.id
    if (!taskId) return
    if (isStreaming) return
    if (!selectedTeam || !isChatShell(selectedTeam)) return

    const tryResumeStream = async () => {
      const resumed = await contextResumeStream(taskId, {
        onComplete: (_completedTaskId, _subtaskId) => {
          refreshSelectedTaskDetail(false)
        },
        onError: error => {
          console.error('[ChatStreamHandlers] Resumed stream error', error)
        },
      })

      if (resumed) {
        setPendingTaskId(taskId)
      }
    }

    tryResumeStream()
  }, [
    selectedTaskDetail?.id,
    selectedTeam,
    isStreaming,
    contextResumeStream,
    refreshSelectedTaskDetail,
  ])

  // Helper: create retry button
  const createRetryButton = useCallback(
    (onRetryClick: () => void) => (
      <Button variant="outline" size="sm" onClick={onRetryClick}>
        {t('chat:actions.retry') || '重试'}
      </Button>
    ),
    [t]
  )

  // Helper: handle send errors
  const handleSendError = useCallback(
    (error: Error, message: string) => {
      resetStreamingState()
      const parsedError = parseError(error)
      lastFailedMessageRef.current = message

      // Use getErrorDisplayMessage for consistent error display logic
      const errorMessage = getErrorDisplayMessage(error, (key: string) => t(`chat:${key}`))

      toast({
        variant: 'destructive',
        title: errorMessage,
        action: parsedError.retryable
          ? createRetryButton(() => {
              if (lastFailedMessageRef.current && handleSendMessageRef.current) {
                handleSendMessageRef.current(lastFailedMessageRef.current)
              }
            })
          : undefined,
      })
    },
    [resetStreamingState, toast, t, createRetryButton]
  )

  // Core message sending logic
  const handleSendMessage = useCallback(
    async (overrideMessage?: string) => {
      const message = overrideMessage?.trim() || taskInputMessage.trim()
      if (!message && !shouldHideChatInput) return

      if (!isAttachmentReadyToSend) {
        toast({
          variant: 'destructive',
          title: '请等待文件上传完成',
        })
        return
      }

      // For code type tasks, repository is required
      const effectiveRepo =
        selectedRepo ||
        (selectedTaskDetail
          ? {
              git_url: selectedTaskDetail.git_url,
              git_repo: selectedTaskDetail.git_repo,
              git_repo_id: selectedTaskDetail.git_repo_id,
              git_domain: selectedTaskDetail.git_domain,
            }
          : null)

      if (
        taskType === 'code' &&
        showRepositorySelector &&
        (effectiveRequiresWorkspace ?? teamRequiresWorkspace(selectedTeam)) &&
        !effectiveRepo?.git_repo
      ) {
        toast({
          variant: 'destructive',
          title: 'Please select a repository for code tasks',
        })
        return
      }

      setIsLoading(true)

      // Set local pending state immediately
      setLocalPendingMessage(message)
      setTaskInputMessage('')
      resetAttachment()
      resetContexts?.()

      // Model ID handling
      const modelId = selectedModel?.name === DEFAULT_MODEL_NAME ? undefined : selectedModel?.name

      // Prepare message with external API parameters
      let finalMessage = message
      if (Object.keys(externalApiParams).length > 0) {
        const paramsJson = JSON.stringify(externalApiParams)
        finalMessage = `[EXTERNAL_API_PARAMS]${paramsJson}[/EXTERNAL_API_PARAMS]\n${message}`
      }

      try {
        const immediateTaskId = selectedTaskDetail?.id || -Date.now()

        // Convert selected contexts to backend format
        // Each context item contains type and data fields
        const contextItems: Array<{
          type: 'knowledge_base' | 'table' | 'selected_documents'
          data: Record<string, unknown>
        }> = selectedContexts.map(ctx => {
          if (ctx.type === 'knowledge_base') {
            return {
              type: 'knowledge_base' as const,
              data: {
                knowledge_id: ctx.id,
                name: ctx.name,
                document_count: ctx.document_count,
              },
            }
          }
          // ctx.type === 'table'
          return {
            type: 'table' as const,
            data: {
              document_id: ctx.document_id,
              name: ctx.name,
              source_config: ctx.source_config,
            },
          }
        })

        // Add selected document IDs as a context for notebook mode
        // This allows direct content injection of selected documents
        if (
          taskType === 'knowledge' &&
          selectedDocumentIds &&
          selectedDocumentIds.length > 0 &&
          knowledgeBaseId
        ) {
          contextItems.push({
            type: 'selected_documents' as const,
            data: {
              knowledge_base_id: knowledgeBaseId,
              document_ids: selectedDocumentIds,
            },
          })
        }

        // Build pending contexts for immediate display (SubtaskContextBrief format)
        // This includes attachments, knowledge bases, and tables
        const pendingContexts: Array<{
          id: number
          context_type: 'attachment' | 'knowledge_base' | 'table'
          name: string
          status: 'pending' | 'ready'
          file_extension?: string
          file_size?: number
          mime_type?: string
          document_count?: number
          source_config?: {
            url?: string
          }
        }> = []

        // Add attachments as contexts
        for (const attachment of attachments) {
          pendingContexts.push({
            id: attachment.id,
            context_type: 'attachment',
            name: attachment.filename,
            status: attachment.status === 'ready' ? 'ready' : 'pending',
            file_extension: attachment.file_extension,
            file_size: attachment.file_size,
            mime_type: attachment.mime_type,
          })
        }

        // Add knowledge bases and tables as contexts
        for (const ctx of selectedContexts) {
          if (ctx.type === 'knowledge_base') {
            const kbContext = ctx as typeof ctx & { document_count?: number }
            pendingContexts.push({
              id: typeof ctx.id === 'number' ? ctx.id : parseInt(String(ctx.id), 10),
              context_type: 'knowledge_base',
              name: ctx.name,
              status: 'ready',
              document_count: kbContext.document_count,
            })
          } else if (ctx.type === 'table') {
            const tableContext = ctx as typeof ctx & { source_config?: { url?: string } }
            pendingContexts.push({
              id: typeof ctx.id === 'number' ? ctx.id : parseInt(String(ctx.id), 10),
              context_type: 'table',
              name: ctx.name,
              status: 'ready',
              source_config: tableContext.source_config,
            })
          }
        }

        const tempTaskId = await contextSendMessage(
          {
            message: finalMessage,
            team_id: selectedTeam?.id ?? 0,
            task_id: selectedTaskDetail?.id,
            model_id: modelId,
            force_override_bot_model: forceOverride,
            force_override_bot_model_type: selectedModel?.type,
            attachment_ids: attachments.map(a => a.id),
            enable_deep_thinking: enableDeepThinking,
            enable_clarification: enableClarification,
            is_group_chat: selectedTaskDetail?.is_group_chat || false,
            git_url: showRepositorySelector ? effectiveRepo?.git_url : undefined,
            git_repo: showRepositorySelector ? effectiveRepo?.git_repo : undefined,
            git_repo_id: showRepositorySelector ? effectiveRepo?.git_repo_id : undefined,
            git_domain: showRepositorySelector ? effectiveRepo?.git_domain : undefined,
            branch_name: showRepositorySelector
              ? selectedBranch?.name || selectedTaskDetail?.branch_name
              : undefined,
            task_type: taskType,
            knowledge_base_id: taskType === 'knowledge' ? knowledgeBaseId : undefined,
            contexts: contextItems.length > 0 ? contextItems : undefined,
          },
          {
            pendingUserMessage: message,
            pendingAttachments: attachments,
            pendingContexts: pendingContexts.length > 0 ? pendingContexts : undefined,
            immediateTaskId: immediateTaskId,
            currentUserId: user?.id,
            onMessageSent: (
              _localMessageId: string,
              completedTaskId: number,
              _subtaskId: number
            ) => {
              if (completedTaskId > 0) {
                setPendingTaskId(completedTaskId)
              }

              // Call onTaskCreated callback when a new task is created
              // This is used for binding knowledge base to the task
              if (completedTaskId && !selectedTaskDetail?.id && onTaskCreated) {
                onTaskCreated(completedTaskId)
              }

              if (completedTaskId && !selectedTaskDetail?.id) {
                const params = new URLSearchParams(Array.from(searchParams.entries()))
                params.set('taskId', String(completedTaskId))
                router.push(`?${params.toString()}`)
                refreshTasks()
              }

              if (selectedTaskDetail?.is_group_chat && completedTaskId) {
                markTaskAsViewed(
                  completedTaskId,
                  selectedTaskDetail.status,
                  new Date().toISOString()
                )
              }
            },
            onError: (error: Error) => {
              handleSendError(error, message)
            },
          }
        )

        if (tempTaskId !== immediateTaskId && tempTaskId > 0) {
          setPendingTaskId(tempTaskId)
        }

        setTimeout(() => scrollToBottom(true), 0)
      } catch (err) {
        handleSendError(err as Error, message)
      }

      setIsLoading(false)
    },
    [
      taskInputMessage,
      shouldHideChatInput,
      isAttachmentReadyToSend,
      toast,
      selectedTeam,
      attachments,
      resetAttachment,
      selectedContexts,
      resetContexts,
      selectedModel?.name,
      selectedModel?.type,
      selectedTaskDetail,
      contextSendMessage,
      forceOverride,
      enableDeepThinking,
      enableClarification,
      refreshTasks,
      searchParams,
      router,
      showRepositorySelector,
      selectedRepo,
      selectedBranch,
      taskType,
      knowledgeBaseId,
      markTaskAsViewed,
      user?.id,
      handleSendError,
      scrollToBottom,
      setIsLoading,
      setTaskInputMessage,
      externalApiParams,
      onTaskCreated,
      selectedDocumentIds,
    ]
  )

  /**
   * Send a message with a temporary model override.
   * This is used for regeneration where user selects a specific model for that single regeneration.
   * The model override only affects this single call and does not change the session's model preference.
   * @param overrideMessage - The message content to send
   * @param modelOverride - The model to use for this single request
   * @param existingContexts - Optional existing contexts from original message (for regeneration)
   */
  const handleSendMessageWithModel = useCallback(
    async (
      overrideMessage: string,
      modelOverride: Model,
      existingContexts?: SubtaskContextBrief[]
    ) => {
      const message = overrideMessage.trim()
      if (!message && !shouldHideChatInput) return

      if (!isAttachmentReadyToSend) {
        toast({
          variant: 'destructive',
          title: t('chat:upload.wait_for_upload'),
        })
        return
      }

      // For code type tasks, repository is required
      const effectiveRepo =
        selectedRepo ||
        (selectedTaskDetail
          ? {
              git_url: selectedTaskDetail.git_url,
              git_repo: selectedTaskDetail.git_repo,
              git_repo_id: selectedTaskDetail.git_repo_id,
              git_domain: selectedTaskDetail.git_domain,
            }
          : null)

      if (
        taskType === 'code' &&
        showRepositorySelector &&
        (effectiveRequiresWorkspace ?? teamRequiresWorkspace(selectedTeam)) &&
        !effectiveRepo?.git_repo
      ) {
        toast({
          variant: 'destructive',
          title: t('common:selector.repository') || 'Please select a repository for code tasks',
        })
        return
      }

      setIsLoading(true)

      // Set local pending state immediately
      setLocalPendingMessage(message)
      setTaskInputMessage('')
      // Note: Don't reset attachments/contexts for regeneration since we're reusing existing ones

      // Use the override model instead of the selected model
      const modelId = modelOverride.name === DEFAULT_MODEL_NAME ? undefined : modelOverride.name

      // Prepare message with external API parameters
      let finalMessage = message
      if (Object.keys(externalApiParams).length > 0) {
        const paramsJson = JSON.stringify(externalApiParams)
        finalMessage = `[EXTERNAL_API_PARAMS]${paramsJson}[/EXTERNAL_API_PARAMS]\n${message}`
      }

      try {
        const immediateTaskId = selectedTaskDetail?.id || -Date.now()

        // Extract attachment IDs from existing contexts (for regeneration)
        const attachmentIds =
          existingContexts?.filter(ctx => ctx.context_type === 'attachment').map(ctx => ctx.id) ||
          []

        // Build context items for backend from existing contexts (knowledge bases, tables)
        const contextItems: Array<{
          type: 'knowledge_base' | 'table' | 'selected_documents'
          data: Record<string, unknown>
        }> = []

        if (existingContexts) {
          for (const ctx of existingContexts) {
            if (ctx.context_type === 'knowledge_base') {
              contextItems.push({
                type: 'knowledge_base' as const,
                data: {
                  knowledge_id: ctx.id,
                  name: ctx.name,
                  document_count: ctx.document_count,
                },
              })
            } else if (ctx.context_type === 'table') {
              contextItems.push({
                type: 'table' as const,
                data: {
                  document_id: ctx.id,
                  name: ctx.name,
                  source_config: ctx.source_config,
                },
              })
            }
          }
        }

        // Build pending contexts for immediate display from existing contexts
        const pendingContexts: Array<{
          id: number
          context_type: 'attachment' | 'knowledge_base' | 'table'
          name: string
          status: 'pending' | 'ready'
          file_extension?: string
          file_size?: number
          mime_type?: string
          document_count?: number
          source_config?: {
            url?: string
          }
        }> =
          existingContexts?.map(ctx => ({
            id: ctx.id,
            context_type: ctx.context_type,
            name: ctx.name,
            status: 'ready' as const,
            file_extension: ctx.file_extension ?? undefined,
            file_size: ctx.file_size ?? undefined,
            mime_type: ctx.mime_type ?? undefined,
            document_count: ctx.document_count ?? undefined,
            source_config: ctx.source_config ?? undefined,
          })) || []

        const tempTaskId = await contextSendMessage(
          {
            message: finalMessage,
            team_id: selectedTeam?.id ?? 0,
            task_id: selectedTaskDetail?.id,
            model_id: modelId,
            force_override_bot_model: true, // Always force override when using model override
            force_override_bot_model_type: modelOverride.type,
            attachment_ids: attachmentIds,
            enable_deep_thinking: enableDeepThinking,
            enable_clarification: enableClarification,
            is_group_chat: selectedTaskDetail?.is_group_chat || false,
            git_url: showRepositorySelector ? effectiveRepo?.git_url : undefined,
            git_repo: showRepositorySelector ? effectiveRepo?.git_repo : undefined,
            git_repo_id: showRepositorySelector ? effectiveRepo?.git_repo_id : undefined,
            git_domain: showRepositorySelector ? effectiveRepo?.git_domain : undefined,
            branch_name: showRepositorySelector
              ? selectedBranch?.name || selectedTaskDetail?.branch_name
              : undefined,
            task_type: taskType,
            knowledge_base_id: taskType === 'knowledge' ? knowledgeBaseId : undefined,
            contexts: contextItems.length > 0 ? contextItems : undefined,
          },
          {
            pendingUserMessage: message,
            pendingAttachments: [], // Attachments are already part of pendingContexts
            pendingContexts: pendingContexts.length > 0 ? pendingContexts : undefined,
            immediateTaskId: immediateTaskId,
            currentUserId: user?.id,
            onMessageSent: (
              _localMessageId: string,
              completedTaskId: number,
              _subtaskId: number
            ) => {
              if (completedTaskId > 0) {
                setPendingTaskId(completedTaskId)
              }

              // Call onTaskCreated callback when a new task is created
              if (completedTaskId && !selectedTaskDetail?.id && onTaskCreated) {
                onTaskCreated(completedTaskId)
              }

              if (completedTaskId && !selectedTaskDetail?.id) {
                const params = new URLSearchParams(Array.from(searchParams.entries()))
                params.set('taskId', String(completedTaskId))
                router.push(`?${params.toString()}`)
                refreshTasks()
              }

              if (selectedTaskDetail?.is_group_chat && completedTaskId) {
                markTaskAsViewed(
                  completedTaskId,
                  selectedTaskDetail.status,
                  new Date().toISOString()
                )
              }
            },
            onError: (error: Error) => {
              handleSendError(error, message)
            },
          }
        )

        if (tempTaskId !== immediateTaskId && tempTaskId > 0) {
          setPendingTaskId(tempTaskId)
        }

        setTimeout(() => scrollToBottom(true), 0)
      } catch (err) {
        handleSendError(err as Error, message)
      }

      setIsLoading(false)
    },
    [
      shouldHideChatInput,
      isAttachmentReadyToSend,
      toast,
      selectedTeam,
      selectedTaskDetail,
      contextSendMessage,
      enableDeepThinking,
      enableClarification,
      refreshTasks,
      searchParams,
      router,
      showRepositorySelector,
      selectedRepo,
      selectedBranch,
      taskType,
      knowledgeBaseId,
      markTaskAsViewed,
      user?.id,
      handleSendError,
      scrollToBottom,
      setIsLoading,
      setTaskInputMessage,
      externalApiParams,
      onTaskCreated,
      t,
    ]
  )

  // Update ref when handleSendMessage changes
  useEffect(() => {
    handleSendMessageRef.current = handleSendMessage
  }, [handleSendMessage])

  // Handle retry for failed messages
  const handleRetry = useCallback(
    async (message: { content: string; type: string; error?: string; subtaskId?: number }) => {
      if (!message.subtaskId) {
        toast({
          variant: 'destructive',
          title: t('chat:errors.generic_error'),
          description: 'Subtask ID not found',
        })
        return
      }

      if (!selectedTaskDetail?.id) {
        toast({
          variant: 'destructive',
          title: t('chat:errors.generic_error'),
          description: 'Task ID not found',
        })
        return
      }

      await traceAction(
        'chat-retry-message',
        {
          'action.type': 'retry',
          'task.id': selectedTaskDetail.id.toString(),
          'subtask.id': message.subtaskId.toString(),
          ...(selectedModel && { 'model.id': selectedModel.name }),
        },
        async () => {
          try {
            const modelId =
              selectedModel?.name === DEFAULT_MODEL_NAME ? undefined : selectedModel?.name
            const modelType = modelId ? selectedModel?.type : undefined

            const result = await retryMessage(
              selectedTaskDetail.id,
              message.subtaskId!,
              modelId,
              modelType,
              forceOverride
            )

            if (result.error) {
              const errorMessage = getErrorDisplayMessage(result.error, (key: string) =>
                t(`chat:${key}`)
              )
              toast({
                variant: 'destructive',
                title: errorMessage,
              })
            }
          } catch (error) {
            console.error('[ChatStreamHandlers] Retry failed:', error)
            const errorMessage = getErrorDisplayMessage(error as Error, (key: string) =>
              t(`chat:${key}`)
            )
            toast({
              variant: 'destructive',
              title: errorMessage,
            })
            throw error
          }
        }
      )
    },
    [retryMessage, selectedTaskDetail?.id, selectedModel, forceOverride, t, toast, traceAction]
  )

  // Handle cancel task
  const handleCancelTask = useCallback(async () => {
    if (!selectedTaskDetail?.id || isCancelling) return

    setIsCancelling(true)

    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Cancel operation timed out')), 60000)
      })

      await Promise.race([taskApis.cancelTask(selectedTaskDetail.id), timeoutPromise])

      toast({
        title: 'Task cancelled successfully',
        description: 'The task has been cancelled.',
      })

      refreshTasks()
      refreshSelectedTaskDetail(false)
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error && err.message === 'Cancel operation timed out'
          ? 'Cancel operation timed out, please check task status later'
          : 'Failed to cancel task'

      toast({
        variant: 'destructive',
        title: errorMessage,
        action: (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setIsCancelling(false)
              handleCancelTask()
            }}
          >
            Retry
          </Button>
        ),
      })

      console.error('Cancel task failed:', err)

      if (err instanceof Error && err.message === 'Cancel operation timed out') {
        refreshTasks()
        refreshSelectedTaskDetail(false)
      }
    } finally {
      setIsCancelling(false)
    }
  }, [selectedTaskDetail?.id, isCancelling, toast, refreshTasks, refreshSelectedTaskDetail])

  return {
    // Stream state
    pendingTaskId,
    currentStreamState,
    isStreaming,
    isSubtaskStreaming,
    isStopping,
    hasPendingUserMessage,
    localPendingMessage,

    // Actions
    handleSendMessage,
    handleSendMessageWithModel,
    handleRetry,
    handleCancelTask,
    stopStream,
    resetStreamingState,

    // Group chat handlers
    handleNewMessages,
    handleStreamComplete,

    // State
    isCancelling,
  }
}

export default useChatStreamHandlers
