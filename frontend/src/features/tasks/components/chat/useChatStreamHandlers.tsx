// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useTaskContext } from '../../contexts/taskContext'
import { useChatStreamContext } from '../../contexts/chatStreamContext'
import { useSocket } from '@/contexts/SocketContext'
import { useDevices } from '@/contexts/DeviceContext'
import { useProjectContext } from '@/features/projects/contexts/projectContext'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { useTraceAction } from '@/hooks/useTraceAction'
import { parseError, getErrorDisplayMessage } from '@/utils/errorParser'
import { taskApis } from '@/apis/tasks'
import { isChatShell, teamRequiresWorkspace } from '../../service/messageService'
import { Button } from '@/components/ui/button'
import { DEFAULT_MODEL_NAME, unifiedToModel } from '../../hooks/useModelSelection'
import { useTaskStateMachine } from '../../hooks/useTaskStateMachine'
import { generateMessageId } from '../../state'
import { getStreamingJoinWarningKey } from './streamingJoinWarning'
import {
  useMessageSendQueue,
  type QueuedMessage,
  type QueuedMessageStatus,
} from './useMessageSendQueue'
import { useGuidanceQueue, type GuidanceQueueItem } from './useGuidanceQueue'
import type { Model } from '../selector/ModelSelector'
import type { UnifiedModel } from '@/apis/models'
import type {
  Team,
  GitRepoInfo,
  GitBranch,
  Attachment,
  SubtaskContextBrief,
  TaskType,
} from '@/types/api'
import type { ContextItem } from '@/types/context'
import type { SkillRef } from '../../hooks/useSkillSelector'

export interface UseChatStreamHandlersOptions {
  // Team and model
  selectedTeam: Team | null
  selectedModel: Model | null
  forceOverride: boolean
  setSelectedModel: (model: Model | null) => void
  setForceOverride: (value: boolean) => void

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
  taskType: TaskType

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

  // Skill selection
  /** Additional skills selected by user (backend determines preload vs download based on executor type) */
  additionalSkills?: SkillRef[]

  // Generation mode props (used when taskType === 'video' or 'image')
  /** Generation-specific parameters (resolution, ratio, etc.) */
  generateParams?: GenerateParams
}

/**
 * Parameters for content generation (video, image, etc.)
 * Used when taskType is 'video' or 'image' to provide generation-specific settings.
 */
export interface GenerateParams {
  /** Resolution for generation (e.g., '1080p', '720p', '480p') */
  resolution?: string
  /** Aspect ratio for generation (e.g., '16:9', '9:16', '1:1') */
  ratio?: string
  /** Duration in seconds for video generation */
  duration?: number
  /** Model name for video/image generation (for display in user message) */
  model?: string
  /** Image size for image generation (e.g., '2048x2048') */
  size?: string
}

export interface ChatStreamHandlers {
  // Stream state
  /** Pending task ID - can be tempTaskId (negative) or taskId (positive) before selectedTaskDetail updates */
  pendingTaskId: number | null
  isStreaming: boolean
  isAwaitingResponseStart: boolean
  isSubtaskStreaming: boolean
  isStopping: boolean
  hasPendingUserMessage: boolean
  localPendingMessage: string | null
  canQueueMessage: boolean
  queuedMessageCount: number
  queuedMessages: QueuedChatMessagePreview[]
  cancelQueuedMessage: (id: string) => void
  sendQueuedAsGuidance: (id: string) => Promise<void>
  canSendGuidance: boolean
  guidanceMessages: GuidanceMessagePreview[]
  expiredGuidanceMessages: GuidanceMessagePreview[]
  cancelGuidance: (id: string) => void
  handleSendGuidance: (overrideMessage?: string) => Promise<void>
  sendExpiredGuidanceAsMessage: (id: string) => Promise<void>

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
  }) => Promise<boolean>
  handleRetryWithModel: (message: { subtaskId?: number }, model: UnifiedModel) => Promise<boolean>
  handleCancelTask: () => Promise<void>
  stopStream: () => Promise<void>
  resetStreamingState: () => void

  // Group chat handlers
  handleNewMessages: (messages: unknown[]) => void
  handleStreamComplete: (subtaskId: number, result?: Record<string, unknown>) => void

  // State
  isCancelling: boolean
}

export interface QueuedChatMessagePreview {
  id: string
  displayMessage: string
  status: QueuedMessageStatus
  error?: string
}

export interface GuidanceMessagePreview {
  id: string
  displayMessage: string
  status: GuidanceQueueItem['status']
  error?: string
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
  setSelectedModel,
  setForceOverride,
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
  additionalSkills,
  generateParams,
}: UseChatStreamHandlersOptions): ChatStreamHandlers {
  const { toast } = useToast()
  const { t } = useTranslation()
  const { user } = useUser()
  const { traceAction } = useTraceAction()
  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()

  const { selectedTaskDetail, refreshTasks, refreshSelectedTaskDetail, markTaskAsViewed } =
    useTaskContext()

  const {
    sendMessage: contextSendMessage,
    stopStream: contextStopStream,
    clearVersion,
  } = useChatStreamContext()

  type ContextSendRequest = Parameters<typeof contextSendMessage>[0]
  type ContextSendOptions = NonNullable<Parameters<typeof contextSendMessage>[1]>

  interface PreparedChatSend {
    localMessageId: string
    displayMessage: string
    sourceMessage: string
    request: ContextSendRequest
    options: ContextSendOptions
  }

  const { retryMessage, sendChatGuidance, registerChatHandlers } = useSocket()

  // Get selected device ID for executor-based tasks
  const { selectedDeviceId } = useDevices()
  const { projects, refreshProjects } = useProjectContext()

  // Project context - for workspace project conversations
  const projectId = searchParams?.get('projectId')
    ? Number(searchParams.get('projectId'))
    : undefined
  const projectConfig = useMemo(() => {
    if (!projectId) return null
    const project = projects.find(p => p.id === projectId)
    return project?.config ?? null
  }, [projectId, projects])
  const projectDeviceId = projectConfig?.execution?.deviceId ?? undefined

  // Determine if we're in device mode - devices page or chat page with device selected
  // This prevents coding tasks from accidentally inheriting a device_id
  const isDevicesPage = pathname?.startsWith('/devices')
  const isDeviceMode = isDevicesPage || taskType === 'task' || !!projectId

  // Determine effective device_id to send:
  // - Send device_id when in device mode (devices page or chat page with device selected) AND team is not Chat Shell
  // - For project conversations, use the project's configured device
  // - This ensures coding tasks don't get routed to devices
  const effectiveDeviceId =
    isDeviceMode && !isChatShell(selectedTeam)
      ? projectDeviceId || selectedDeviceId || undefined
      : undefined

  // Local state
  const [pendingTaskId, setPendingTaskId] = useState<number | null>(null)
  const [localPendingMessage, setLocalPendingMessage] = useState<string | null>(null)
  const [isAwaitingResponseStart, setIsAwaitingResponseStart] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)

  // Refs
  const lastFailedMessageRef = useRef<string | null>(null)
  const handleSendMessageRef = useRef<((message?: string) => Promise<void>) | null>(null)
  const previousTaskIdRef = useRef<number | null | undefined>(undefined)
  const prevTaskIdForModelRef = useRef<number | null | undefined>(undefined)
  const prevClearVersionRef = useRef(clearVersion)
  const lastJoinWarningRef = useRef<string | null>(null)
  const retryQueuedMessageRef = useRef<((id: string) => void) | null>(null)

  // Unified function to reset streaming-related state
  const resetStreamingState = useCallback(() => {
    setLocalPendingMessage(null)
    setPendingTaskId(null)
    setIsAwaitingResponseStart(false)
  }, [])

  // Get current display task ID
  const currentDisplayTaskId = selectedTaskDetail?.id

  // Determine effective task ID for state machine subscription
  // Use currentDisplayTaskId if available, otherwise use pendingTaskId
  const effectiveTaskIdForState = useMemo(() => {
    return currentDisplayTaskId || pendingTaskId || undefined
  }, [currentDisplayTaskId, pendingTaskId])

  // Use useTaskStateMachine to properly subscribe to state changes
  // This ensures isStreaming updates when chat:done is received
  // IMPORTANT: All streaming state comes from the state machine - no local state variables
  const { state: taskState, isStreaming: isMachineStreaming } =
    useTaskStateMachine(effectiveTaskIdForState)

  // Keep "stop" state aligned with backend task lifecycle:
  // a task can stay RUNNING even when no stream chunk is currently arriving.
  // In that window, UI should still block sending and show stop action.
  const isStreaming = isMachineStreaming || selectedTaskDetail?.status === 'RUNNING'

  // Alias for backward compatibility - both refer to the same state machine value
  const isSubtaskStreaming = isStreaming
  const isStopping = taskState?.isStopping || false

  useEffect(() => {
    if (isMachineStreaming || selectedTaskDetail?.status === 'RUNNING') {
      setIsAwaitingResponseStart(false)
    }
  }, [isMachineStreaming, selectedTaskDetail?.status])
  // Check for pending user messages
  const hasPendingUserMessage = useMemo(() => {
    if (localPendingMessage) return true
    if (!taskState?.messages) return false
    for (const msg of taskState.messages.values()) {
      if (msg.type === 'user' && msg.status === 'pending') return true
    }
    return false
  }, [localPendingMessage, taskState?.messages])

  // Stop stream wrapper
  // Note: subtasks parameter is no longer passed to contextStopStream
  // The streaming subtask info is now obtained from TaskStateMachine state
  const stopStream = useCallback(async () => {
    const taskIdToStop = currentDisplayTaskId || pendingTaskId

    if (taskIdToStop && taskIdToStop > 0) {
      const team =
        typeof selectedTaskDetail?.team === 'object' ? selectedTaskDetail.team : undefined
      await contextStopStream(taskIdToStop, undefined, team)
    }
  }, [currentDisplayTaskId, pendingTaskId, contextStopStream, selectedTaskDetail?.team])

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

  // Show join-time warning for long-running streaming tasks recovered from WebSocket join
  useEffect(() => {
    const streamingInfo = taskState?.streamingInfo
    if (!streamingInfo || taskState?.status !== 'streaming') {
      lastJoinWarningRef.current = null
      return
    }

    const warningKey = getStreamingJoinWarningKey({
      started_at: streamingInfo.started_at,
      last_activity_at: streamingInfo.last_activity_at,
    })

    const nowMs = Date.now()
    const startedAtMs = streamingInfo.started_at ? Date.parse(streamingInfo.started_at) : NaN
    const lastActivityAtMs = streamingInfo.last_activity_at
      ? Date.parse(streamingInfo.last_activity_at)
      : NaN
    console.info('[StreamingJoinDebug] warning evaluation', {
      taskId: selectedTaskDetail?.id || pendingTaskId || 0,
      status: taskState?.status,
      subtaskId: streamingInfo.subtask_id,
      startedAt: streamingInfo.started_at,
      lastActivityAt: streamingInfo.last_activity_at,
      startedAgeMs: Number.isNaN(startedAtMs) ? null : nowMs - startedAtMs,
      lastActivityAgeMs: Number.isNaN(lastActivityAtMs) ? null : nowMs - lastActivityAtMs,
      warningKey,
    })

    if (!warningKey) return

    const taskId = selectedTaskDetail?.id || pendingTaskId || 0
    const dedupeKey = `${taskId}:${warningKey}`
    if (lastJoinWarningRef.current === dedupeKey) return

    lastJoinWarningRef.current = dedupeKey
    toast({
      title: t(warningKey),
      variant: 'warning',
    })
  }, [pendingTaskId, selectedTaskDetail?.id, t, taskState?.status, taskState?.streamingInfo, toast])

  // Note: Stream recovery is now handled by TaskStateMachine via useUnifiedMessages
  // The state machine automatically recovers streaming state when:
  // - Task is selected (via recover() in useUnifiedMessages)
  // - Page becomes visible (via usePageVisibility in chatStreamContext)
  // - WebSocket reconnects (via TaskStateManager.recoverAll())

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

  const prepareChatSend = useCallback(
    (
      message: string,
      localMessageId: string,
      immediateTaskId: number,
      effectiveRepo: Pick<GitRepoInfo, 'git_url' | 'git_repo' | 'git_repo_id' | 'git_domain'> | null
    ): PreparedChatSend => {
      const snapshotAttachments = [...attachments]
      const snapshotContexts = [...selectedContexts]
      const snapshotAdditionalSkills = additionalSkills ? [...additionalSkills] : undefined
      const modelId = selectedModel?.name === DEFAULT_MODEL_NAME ? undefined : selectedModel?.name

      let finalMessage = message
      if (Object.keys(externalApiParams).length > 0) {
        const paramsJson = JSON.stringify(externalApiParams)
        finalMessage = `[EXTERNAL_API_PARAMS]${paramsJson}[/EXTERNAL_API_PARAMS]\n${message}`
      }

      const contextItems: Array<{
        type: 'knowledge_base' | 'table' | 'selected_documents'
        data: Record<string, unknown>
      }> = snapshotContexts
        .filter(ctx => ctx.type !== 'queue_message' && ctx.type !== 'dingtalk_doc')
        .map(ctx => {
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
          return {
            type: 'table' as const,
            data: {
              document_id: (ctx as { document_id: number }).document_id,
              name: ctx.name,
              source_config: (ctx as { source_config?: { url?: string } }).source_config,
            },
          }
        })

      let messageWithQueueContent = finalMessage
      const queueMessageContexts = snapshotContexts.filter(ctx => ctx.type === 'queue_message')
      if (queueMessageContexts.length > 0) {
        const queueContents = queueMessageContexts
          .map(ctx => (ctx as import('@/types/context').QueueMessageContext).fullContent)
          .join('\n\n---\n\n')
        messageWithQueueContent = `${queueContents}\n\n---\n\n${finalMessage}`
      }

      const dingtalkDocContexts = snapshotContexts.filter(ctx => ctx.type === 'dingtalk_doc')
      if (dingtalkDocContexts.length > 0) {
        const docRefs = dingtalkDocContexts
          .map(ctx => {
            const docCtx = ctx as import('@/types/context').DingTalkDocContext
            return `- [${docCtx.name}](${docCtx.doc_url})`
          })
          .join('\n')
        const dingtalkPrefix = `**${t('chat:dingtalkDocs.referencedDocsLabel')}**\n${docRefs}\n\n---\n\n`
        messageWithQueueContent = `${dingtalkPrefix}${messageWithQueueContent}`
      }

      const queueAttachmentIds = queueMessageContexts.flatMap(
        ctx => (ctx as import('@/types/context').QueueMessageContext).attachmentContextIds ?? []
      )

      const inboxAttachmentContexts = queueMessageContexts.flatMap(
        ctx => (ctx as import('@/types/context').QueueMessageContext).inboxAttachments ?? []
      )

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

      const pendingContexts: Array<{
        id: number
        context_type: 'attachment' | 'knowledge_base' | 'table'
        name: string
        status: 'pending' | 'ready'
        file_extension?: string
        file_size?: number
        mime_type?: string
        document_count?: number
        knowledge_id?: number
        document_id?: number
        source_config?: {
          url?: string
        }
      }> = []

      for (const attachment of snapshotAttachments) {
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

      for (const inboxAtt of inboxAttachmentContexts) {
        pendingContexts.push({
          id: inboxAtt.id,
          context_type: 'attachment',
          name: inboxAtt.name,
          status: 'ready',
          file_extension: inboxAtt.file_extension,
          file_size: inboxAtt.file_size,
          mime_type: inboxAtt.mime_type,
        })
      }

      for (const ctx of snapshotContexts) {
        if (ctx.type === 'knowledge_base') {
          const kbContext = ctx as typeof ctx & { document_count?: number }
          pendingContexts.push({
            id: typeof ctx.id === 'number' ? ctx.id : parseInt(String(ctx.id), 10),
            context_type: 'knowledge_base',
            name: ctx.name,
            status: 'ready',
            knowledge_id: typeof ctx.id === 'number' ? ctx.id : parseInt(String(ctx.id), 10),
            document_count: kbContext.document_count,
          })
        } else if (ctx.type === 'table') {
          const tableContext = ctx as typeof ctx & {
            document_id: number
            source_config?: { url?: string }
          }
          pendingContexts.push({
            id: tableContext.document_id,
            context_type: 'table',
            name: ctx.name,
            status: 'ready',
            document_id: tableContext.document_id,
            source_config: tableContext.source_config,
          })
        }
      }

      const request: ContextSendRequest = {
        message: messageWithQueueContent,
        team_id: selectedTeam?.id ?? 0,
        task_id: selectedTaskDetail?.id,
        model_id: modelId,
        force_override_bot_model: forceOverride,
        force_override_bot_model_type: selectedModel?.type,
        attachment_ids: [...snapshotAttachments.map(a => a.id), ...queueAttachmentIds],
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
        device_id: effectiveDeviceId,
        // Project association for workspace project conversations
        project_id: selectedTaskDetail?.id ? undefined : projectId,
        additional_skills:
          snapshotAdditionalSkills && snapshotAdditionalSkills.length > 0
            ? snapshotAdditionalSkills
            : undefined,
        generate_params: generateParams,
      }

      const options: ContextSendOptions = {
        pendingUserMessage: messageWithQueueContent,
        pendingAttachments: snapshotAttachments,
        pendingContexts: pendingContexts.length > 0 ? pendingContexts : undefined,
        immediateTaskId,
        currentUserId: user?.id,
        onMessageSent: (_localMessageId: string, completedTaskId: number) => {
          if (completedTaskId > 0) {
            setPendingTaskId(completedTaskId)
          }

          if (completedTaskId && !selectedTaskDetail?.id && onTaskCreated) {
            onTaskCreated(completedTaskId)
          }

          if (completedTaskId && !selectedTaskDetail?.id) {
            if (taskType === 'knowledge' && knowledgeBaseId && pathname === '/knowledge') {
              router.push(`/knowledge/document/${knowledgeBaseId}?taskId=${completedTaskId}`)
            } else if (taskType === 'task' && !pathname?.startsWith('/devices')) {
              const params = new URLSearchParams()
              params.set('taskId', String(completedTaskId))
              if (effectiveDeviceId) {
                params.set('deviceId', effectiveDeviceId)
              }
              if (projectId) {
                params.set('projectId', String(projectId))
              }
              router.push(`/devices/chat?${params.toString()}`)
            } else {
              const params = new URLSearchParams(Array.from(searchParams.entries()))
              params.set('taskId', String(completedTaskId))
              router.push(`?${params.toString()}`)
            }
            refreshTasks()
            if (projectId) {
              refreshProjects()
            }
          }

          if (selectedTaskDetail?.is_group_chat && completedTaskId) {
            markTaskAsViewed(completedTaskId, selectedTaskDetail.status, new Date().toISOString())
          }
        },
        onError: (error: Error) => {
          handleSendError(error, message)
        },
      }

      return {
        localMessageId,
        displayMessage: message,
        sourceMessage: messageWithQueueContent,
        request,
        options,
      }
    },
    [
      attachments,
      selectedContexts,
      additionalSkills,
      selectedModel?.name,
      selectedModel?.type,
      externalApiParams,
      taskType,
      selectedDocumentIds,
      knowledgeBaseId,
      t,
      selectedTeam?.id,
      selectedTaskDetail,
      forceOverride,
      enableDeepThinking,
      enableClarification,
      showRepositorySelector,
      selectedBranch?.name,
      effectiveDeviceId,
      generateParams,
      user?.id,
      onTaskCreated,
      pathname,
      router,
      searchParams,
      refreshTasks,
      projectId,
      refreshProjects,
      markTaskAsViewed,
      handleSendError,
    ]
  )

  const sendPreparedChatMessage = useCallback(
    async (prepared: PreparedChatSend, optionOverrides?: Partial<ContextSendOptions>) => {
      const tempTaskId = await contextSendMessage(prepared.request, {
        ...prepared.options,
        ...optionOverrides,
        localMessageId: prepared.localMessageId,
      })

      const immediateTaskId = prepared.options.immediateTaskId || prepared.request.task_id || 0
      if (tempTaskId !== immediateTaskId && tempTaskId > 0) {
        setPendingTaskId(tempTaskId)
      }

      if (selectedTaskDetail?.id) {
        refreshSelectedTaskDetail(false)
      }

      setTimeout(() => scrollToBottom(true), 0)
    },
    [contextSendMessage, refreshSelectedTaskDetail, scrollToBottom, selectedTaskDetail?.id]
  )

  const activeTaskId =
    selectedTaskDetail?.id && selectedTaskDetail.id > 0 ? selectedTaskDetail.id : null
  const isActiveTaskBlocked =
    isStreaming ||
    isAwaitingResponseStart ||
    selectedTaskDetail?.status === 'RUNNING' ||
    selectedTaskDetail?.status === 'PENDING'
  const canQueueMessage = Boolean(
    activeTaskId &&
    (isStreaming || isAwaitingResponseStart || selectedTaskDetail?.status === 'RUNNING')
  )
  const canSendGuidance = Boolean(activeTaskId && isChatShell(selectedTeam) && isStreaming)

  const getActiveSubtaskId = useCallback(() => {
    const streamingSubtaskId = taskState?.streamingInfo?.subtask_id
    if (typeof streamingSubtaskId === 'number') return streamingSubtaskId

    const taskWithSubtasks = selectedTaskDetail as
      | (typeof selectedTaskDetail & { subtasks?: unknown[] })
      | null
    const subtasks = taskWithSubtasks?.subtasks
    if (!Array.isArray(subtasks) || subtasks.length === 0) return null

    const lastSubtask = subtasks[subtasks.length - 1] as { id?: unknown; subtask_id?: unknown }
    const rawId = lastSubtask.subtask_id ?? lastSubtask.id
    return typeof rawId === 'number' ? rawId : null
  }, [selectedTaskDetail, taskState?.streamingInfo?.subtask_id])

  const {
    activeGuidanceQueue,
    expiredGuidance,
    enqueueGuidance,
    markGuidanceSending,
    markGuidanceQueued,
    markGuidanceFailed,
    markGuidanceApplied,
    markGuidanceExpired,
    cancelGuidance,
    removeExpiredGuidance,
  } = useGuidanceQueue({ taskId: activeTaskId })

  useEffect(() => {
    if (canSendGuidance) return

    activeGuidanceQueue.forEach(item => {
      if (item.status === 'queued' || item.status === 'sending') {
        markGuidanceExpired(item.guidanceId, t('chat:guidance.expired'))
      }
    })
  }, [activeGuidanceQueue, canSendGuidance, markGuidanceExpired, t])

  // Register WebSocket handlers for guidance lifecycle events
  useEffect(() => {
    if (!activeTaskId) return
    return registerChatHandlers({
      onGuidanceApplied: payload => {
        console.log('[guidance] WS guidance_applied received:', payload)
        if (payload.task_id === activeTaskId) {
          markGuidanceApplied(payload.guidance_id)
        }
      },
      onGuidanceExpired: payload => {
        console.log('[guidance] WS guidance_expired received:', payload)
        if (payload.task_id === activeTaskId) {
          payload.guidance_ids.forEach(id => markGuidanceExpired(id, t('chat:guidance.expired')))
        }
      },
    })
  }, [activeTaskId, markGuidanceApplied, markGuidanceExpired, registerChatHandlers, t])

  const dispatchQueuedMessage = useCallback(
    async (queuedMessage: QueuedMessage<PreparedChatSend>) => {
      const prepared = queuedMessage.snapshot
      setIsLoading(true)
      setIsAwaitingResponseStart(true)

      try {
        await sendPreparedChatMessage(prepared, { onError: undefined })
      } finally {
        setIsLoading(false)
      }
    },
    [sendPreparedChatMessage, setIsLoading]
  )

  const handleQueuedDispatchError = useCallback(
    (queuedMessage: QueuedMessage<PreparedChatSend>, error: Error) => {
      const retryQueuedMessage = () => {
        retryQueuedMessageRef.current?.(queuedMessage.id)
      }

      setIsAwaitingResponseStart(false)
      setIsLoading(false)
      toast({
        variant: 'destructive',
        title: error.message,
        action: (
          <Button variant="outline" size="sm" onClick={retryQueuedMessage}>
            {t('chat:actions.retry') || 'Retry'}
          </Button>
        ),
      })
    },
    [setIsLoading, t, toast]
  )

  const {
    activeTaskQueue,
    enqueueMessage,
    retryMessage: retryQueuedMessage,
    cancelMessage,
    updateQueuedMessage,
  } = useMessageSendQueue<PreparedChatSend>({
    taskId: activeTaskId,
    isDispatchBlocked: isActiveTaskBlocked,
    dispatchMessage: dispatchQueuedMessage,
    onDispatchError: handleQueuedDispatchError,
    dispatchMode: 'one-per-unblock',
  })
  retryQueuedMessageRef.current = retryQueuedMessage

  const cancelQueuedMessage = useCallback(
    (id: string) => {
      const queuedMessage = activeTaskQueue.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending') return

      cancelMessage(id)

      const restoredMessage = queuedMessage.snapshot.sourceMessage || queuedMessage.displayMessage
      setTaskInputMessage(
        taskInputMessage.trim() ? `${restoredMessage}\n\n${taskInputMessage}` : restoredMessage
      )
    },
    [activeTaskQueue, cancelMessage, setTaskInputMessage, taskInputMessage]
  )

  const queuedMessages = useMemo<QueuedChatMessagePreview[]>(
    () =>
      activeTaskQueue.map(message => ({
        id: message.id,
        displayMessage: message.displayMessage,
        status: message.status,
        error: message.error,
      })),
    [activeTaskQueue]
  )

  const guidanceMessages = useMemo<GuidanceMessagePreview[]>(
    () =>
      activeGuidanceQueue
        .filter(message => message.status !== 'expired')
        .map(message => ({
          id: message.guidanceId,
          displayMessage: message.content,
          status: message.status,
          error: message.error,
        })),
    [activeGuidanceQueue]
  )

  const expiredGuidanceMessages = useMemo<GuidanceMessagePreview[]>(
    () =>
      expiredGuidance.map(message => ({
        id: message.guidanceId,
        displayMessage: message.content,
        status: message.status,
        error: message.error,
      })),
    [expiredGuidance]
  )

  const mergePreparedChatSend = useCallback(
    (current: PreparedChatSend, next: PreparedChatSend): PreparedChatSend => {
      const displayMessage = `${current.displayMessage}\n\n${next.displayMessage}`
      const sourceMessage = `${current.sourceMessage}\n\n${next.sourceMessage}`

      return {
        ...current,
        displayMessage,
        sourceMessage,
        request: {
          ...current.request,
          message: sourceMessage,
          attachment_ids: [
            ...(current.request.attachment_ids ?? []),
            ...(next.request.attachment_ids ?? []),
          ],
          contexts: [...(current.request.contexts ?? []), ...(next.request.contexts ?? [])],
          additional_skills: [
            ...(current.request.additional_skills ?? []),
            ...(next.request.additional_skills ?? []),
          ],
          generate_params: next.request.generate_params ?? current.request.generate_params,
        },
        options: {
          ...current.options,
          pendingUserMessage: sourceMessage,
          pendingAttachments: [
            ...(current.options.pendingAttachments ?? []),
            ...(next.options.pendingAttachments ?? []),
          ],
          pendingContexts: [
            ...(current.options.pendingContexts ?? []),
            ...(next.options.pendingContexts ?? []),
          ],
        },
      }
    },
    []
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

      const immediateTaskId = selectedTaskDetail?.id || -Date.now()
      const localMessageId = generateMessageId('user')
      const prepared = prepareChatSend(message, localMessageId, immediateTaskId, effectiveRepo)

      if (canQueueMessage && activeTaskId) {
        const mergeTarget = [...activeTaskQueue]
          .reverse()
          .find(queuedMessage => queuedMessage.status === 'queued')

        if (mergeTarget) {
          updateQueuedMessage(mergeTarget.id, queuedMessage => {
            const mergedPrepared = mergePreparedChatSend(queuedMessage.snapshot, prepared)
            return {
              ...queuedMessage,
              displayMessage: mergedPrepared.displayMessage,
              snapshot: mergedPrepared,
            }
          })
        } else {
          enqueueMessage({
            taskId: activeTaskId,
            localMessageId,
            displayMessage: prepared.displayMessage,
            snapshot: prepared,
          })
        }
        setTaskInputMessage('')
        resetAttachment()
        resetContexts?.()
        setTimeout(() => scrollToBottom(true), 0)
        return
      }

      setIsLoading(true)
      setIsAwaitingResponseStart(!(selectedTaskDetail?.is_group_chat || false))
      setLocalPendingMessage(message)
      setTaskInputMessage('')
      resetAttachment()
      resetContexts?.()

      if (!selectedTaskDetail?.id) {
        setPendingTaskId(immediateTaskId)
      }

      try {
        await sendPreparedChatMessage(prepared)
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
      selectedRepo,
      selectedTaskDetail,
      taskType,
      showRepositorySelector,
      effectiveRequiresWorkspace,
      selectedTeam,
      prepareChatSend,
      canQueueMessage,
      activeTaskId,
      activeTaskQueue,
      enqueueMessage,
      updateQueuedMessage,
      mergePreparedChatSend,
      setTaskInputMessage,
      resetAttachment,
      resetContexts,
      scrollToBottom,
      setIsLoading,
      sendPreparedChatMessage,
      handleSendError,
    ]
  )

  const handleSendGuidance = useCallback(
    async (overrideMessage?: string) => {
      const message = overrideMessage?.trim() || taskInputMessage.trim()
      if (!message || !activeTaskId || !selectedTeam?.id || !canSendGuidance) return

      const subtaskId = getActiveSubtaskId()
      if (!subtaskId) {
        toast({
          variant: 'destructive',
          title: t('chat:guidance.no_active_stream'),
        })
        return
      }

      const guidanceId = `guidance-${activeTaskId}-${Date.now()}`
      console.log('[guidance] sending:', {
        guidanceId,
        activeTaskId,
        subtaskId,
        teamId: selectedTeam.id,
        message,
      })
      enqueueGuidance({
        taskId: activeTaskId,
        guidanceId,
        content: message,
      })
      markGuidanceSending(guidanceId)
      setTaskInputMessage('')

      try {
        const response = await sendChatGuidance({
          task_id: activeTaskId,
          subtask_id: subtaskId,
          team_id: selectedTeam.id,
          message,
          guidance: message,
          client_guidance_id: guidanceId,
        })

        if (response.error || response.success === false) {
          console.log('[guidance] ACK error:', response)
          markGuidanceFailed(guidanceId, response.error || t('chat:guidance.send_failed'))
          return
        }

        console.log('[guidance] ACK ok, queued:', { guidanceId, response })
        markGuidanceQueued(guidanceId)
        return
      } catch (error) {
        console.log('[guidance] send exception:', error)
        const normalizedError = error instanceof Error ? error : new Error(String(error))
        markGuidanceFailed(guidanceId, normalizedError.message)
      }
    },
    [
      taskInputMessage,
      activeTaskId,
      selectedTeam?.id,
      canSendGuidance,
      getActiveSubtaskId,
      enqueueGuidance,
      markGuidanceSending,
      markGuidanceQueued,
      setTaskInputMessage,
      sendChatGuidance,
      markGuidanceFailed,
      t,
      toast,
    ]
  )

  const sendQueuedAsGuidance = useCallback(
    async (id: string) => {
      const queuedMessage = activeTaskQueue.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending') return
      const text = queuedMessage.snapshot.sourceMessage || queuedMessage.displayMessage
      cancelMessage(id)
      await handleSendGuidance(text)
    },
    [activeTaskQueue, cancelMessage, handleSendGuidance]
  )

  const sendExpiredGuidanceAsMessage = useCallback(
    async (id: string) => {
      const guidance = expiredGuidance.find(item => item.guidanceId === id)
      if (!guidance) return

      removeExpiredGuidance(id)
      await handleSendMessage(guidance.content)
    },
    [expiredGuidance, handleSendMessage, removeExpiredGuidance]
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
      setIsAwaitingResponseStart(!(selectedTaskDetail?.is_group_chat || false))

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
            if (ctx.context_type === 'knowledge_base' && ctx.knowledge_id) {
              contextItems.push({
                type: 'knowledge_base' as const,
                data: {
                  knowledge_id: ctx.knowledge_id,
                  name: ctx.name,
                  document_count: ctx.document_count,
                },
              })
            } else if (ctx.context_type === 'table' && ctx.document_id) {
              contextItems.push({
                type: 'table' as const,
                data: {
                  document_id: ctx.document_id,
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
          knowledge_id?: number
          document_id?: number
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
            knowledge_id: ctx.knowledge_id ?? undefined,
            document_id: ctx.document_id ?? undefined,
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
                if (projectId) {
                  refreshProjects()
                }
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

        if (selectedTaskDetail?.id) {
          refreshSelectedTaskDetail(false)
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
      refreshSelectedTaskDetail,
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
      effectiveRequiresWorkspace,
      projectId,
      refreshProjects,
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
        return false
      }

      if (!selectedTaskDetail?.id) {
        toast({
          variant: 'destructive',
          title: t('chat:errors.generic_error'),
          description: 'Task ID not found',
        })
        return false
      }

      return traceAction(
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
              return false
            }

            return true
          } catch (error) {
            console.error('[ChatStreamHandlers] Retry failed:', error)
            const errorMessage = getErrorDisplayMessage(error as Error, (key: string) =>
              t(`chat:${key}`)
            )
            toast({
              variant: 'destructive',
              title: errorMessage,
            })
            return false
          }
        }
      )
    },
    [retryMessage, selectedTaskDetail?.id, selectedModel, forceOverride, t, toast, traceAction]
  )

  // Handle retry with a specific model (from error card recommendation)
  const handleRetryWithModel = useCallback(
    async (message: { subtaskId?: number }, model: UnifiedModel) => {
      if (!message.subtaskId || !selectedTaskDetail?.id) {
        return false
      }

      try {
        const result = await retryMessage(
          selectedTaskDetail.id,
          message.subtaskId,
          model.name,
          model.type,
          true // forceOverride = true to permanently switch in task metadata
        )

        if (result.error) {
          const errorMessage = getErrorDisplayMessage(result.error, (key: string) =>
            t(`chat:${key}`)
          )
          toast({ variant: 'destructive', title: errorMessage })
          return false
        } else {
          // Switch frontend model state after the backend accepts the retry request.
          setSelectedModel(unifiedToModel(model))
          setForceOverride(true)

          // Refresh task detail to pick up the new model configuration from backend
          refreshSelectedTaskDetail(false)
          return true
        }
      } catch (error) {
        console.error('[ChatStreamHandlers] RetryWithModel failed:', error)
        const errorMessage = getErrorDisplayMessage(error as Error, (key: string) =>
          t(`chat:${key}`)
        )
        toast({ variant: 'destructive', title: errorMessage })
        return false
      }
    },
    [
      retryMessage,
      selectedTaskDetail?.id,
      setSelectedModel,
      setForceOverride,
      refreshSelectedTaskDetail,
      t,
      toast,
    ]
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
    isStreaming,
    isAwaitingResponseStart,
    isSubtaskStreaming,
    isStopping,
    hasPendingUserMessage,
    localPendingMessage,
    canQueueMessage,
    queuedMessageCount: activeTaskQueue.length,
    queuedMessages,
    cancelQueuedMessage,
    sendQueuedAsGuidance,
    canSendGuidance,
    guidanceMessages,
    expiredGuidanceMessages,
    cancelGuidance,
    handleSendGuidance,
    sendExpiredGuidanceAsMessage,

    // Actions
    handleSendMessage,
    handleSendMessageWithModel,
    handleRetry,
    handleRetryWithModel,
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
