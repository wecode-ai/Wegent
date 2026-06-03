// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useMemo } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import type { Task } from '@/types/api'
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
import { generateMessageId } from '../../state'
import {
  useMessageSendQueue,
  type QueuedMessage,
  type QueuedMessageStatus,
} from './useMessageSendQueue'
import { useGuidanceQueue, type GuidanceQueueItem } from './useGuidanceQueue'
import { useChatTransientState } from './useChatTransientState'
import { useGuidanceSocketHandlers } from './useGuidanceSocketHandlers'
import { useQueuedRuntimeHealthCheck } from './useQueuedRuntimeHealthCheck'
import { useStreamingJoinWarning } from './useStreamingJoinWarning'
import type { Model } from '../selector/ModelSelector'
import type { UnifiedModel } from '@/apis/models'
import type {
  Team,
  GitRepoInfo,
  GitBranch,
  Attachment,
  SubtaskContextBrief,
  TaskType,
  InteractiveFormAnswerPayload,
} from '@/types/api'
import type { ContextItem } from '@/types/context'
import type { SkillRef } from '../../hooks/useSkillSelector'

function isVirtualKnowledgeBasePath(path: string): boolean {
  return path.startsWith('/knowledge/') && !path.startsWith('/knowledge/document/')
}

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
  isStopping: boolean
  hasPendingUserMessage: boolean
  canQueueMessage: boolean
  canCancelTask?: boolean
  queuedMessageCount: number
  queuedMessages: QueuedChatMessagePreview[]
  cancelQueuedMessage: (id: string) => void
  editQueuedMessage: (id: string) => void
  sendQueuedAsGuidance: (id: string) => Promise<void>
  canSendGuidance: boolean
  guidanceMessages: GuidanceMessagePreview[]
  expiredGuidanceMessages: GuidanceMessagePreview[]
  cancelGuidance: (id: string) => void
  editGuidanceMessage: (id: string) => void
  handleSendGuidance: (overrideMessage?: string) => Promise<void>
  sendExpiredGuidanceAsMessage: (id: string) => Promise<void>

  // Actions
  handleSendMessage: (
    overrideMessage?: string,
    options?: { interactiveFormAnswer?: InteractiveFormAnswerPayload }
  ) => Promise<void>
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
  handleCancelTask: () => Promise<boolean>
  stopStream: () => Promise<void>
  resetStreamingState: () => void
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
 *
 * This hook extracts all the complex streaming logic from ChatArea
 * to reduce the component size and improve maintainability.
 */
export function useChatStreamHandlers({
  selectedTeam,
  selectedModel,
  setSelectedModel,
  setForceOverride,
  selectedRepo,
  selectedBranch,
  showRepositorySelector,
  effectiveRequiresWorkspace,
  taskInputMessage,
  setTaskInputMessage,
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

  const {
    currentTaskId,
    selectedTaskDetail,
    selectTask,
    refreshTasks,
    refreshSelectedTaskDetail,
    markTaskAsViewed,
    sendMessage: contextSendMessage,
    stopStream: contextStopStream,
    taskState: sessionTaskState,
    recoverCurrentTask,
  } = useTaskSession()

  // Navigate to a knowledge task without triggering Next.js re-renders.
  // Uses selectTask + replaceState to avoid the router.push cascade
  // that causes selectedTaskDetail=null and hasMessages flip (UI flickering).
  const navigateToKnowledgeTask = useCallback(
    (taskId: number, kbId: number) => {
      selectTask({ id: taskId } as Task)
      const params = new URLSearchParams(Array.from(searchParams.entries()))
      params.set('taskId', String(taskId))
      const currentPath = window.location.pathname || pathname || ''
      if (!isVirtualKnowledgeBasePath(currentPath)) {
        params.set('kb', String(kbId))
      }
      window.history.replaceState({}, '', `?${params.toString()}`)
    },
    [selectTask, searchParams, pathname]
  )

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

  // Refs
  const lastFailedMessageRef = useRef<string | null>(null)
  const handleSendMessageRef = useRef<
    | ((
        message?: string,
        options?: { interactiveFormAnswer?: InteractiveFormAnswerPayload }
      ) => Promise<void>)
    | null
  >(null)
  const retryQueuedMessageRef = useRef<((id: string) => void) | null>(null)

  const { pendingTaskId, setPendingTaskId, resetStreamingState, effectiveTaskIdForState } =
    useChatTransientState({
      selectedTaskId: currentTaskId,
    })

  const taskState =
    sessionTaskState && sessionTaskState.taskId === effectiveTaskIdForState
      ? sessionTaskState
      : null
  const isMachineStreaming = taskState?.phase === 'streaming'
  const runtimeDerived = taskState?.derived
  const activeStreamSubtaskId = taskState?.runtime.activeStreamSubtaskId

  // Keep "stop" state aligned with backend task lifecycle:
  // a task can stay RUNNING even when no stream chunk is currently arriving.
  // In that window, UI should still block sending and show stop action.
  const runtimeTaskStatus = taskState?.runtime.taskStatus
  const isRunningLifecycle = runtimeTaskStatus === 'RUNNING'

  const isStopping = taskState?.isStopping || false

  // Check for pending user messages
  const hasPendingUserMessage = useMemo(() => {
    if (!taskState?.messages) return false
    for (const msg of taskState.messages.values()) {
      if (msg.type === 'user' && msg.status === 'pending') return true
    }
    return false
  }, [taskState?.messages])
  const isStreaming = isMachineStreaming || isRunningLifecycle || hasPendingUserMessage

  // Stop stream wrapper
  // Note: subtasks parameter is no longer passed to contextStopStream
  // The streaming subtask info is now obtained from TaskStateMachine state
  const stopStream = useCallback(async () => {
    const taskIdToStop = currentTaskId || pendingTaskId

    if (taskIdToStop && taskIdToStop > 0) {
      const team =
        typeof selectedTaskDetail?.team === 'object' ? selectedTaskDetail.team : undefined
      await contextStopStream(taskIdToStop, undefined, team)
    }
  }, [currentTaskId, pendingTaskId, contextStopStream, selectedTaskDetail?.team])

  const notifyStreamingJoinWarning = useCallback(
    (title: string) => toast({ title, variant: 'warning' }),
    [toast]
  )

  useStreamingJoinWarning({
    taskId: currentTaskId || pendingTaskId,
    phase: taskState?.phase,
    runtime: taskState?.runtime,
    translate: t,
    notify: notifyStreamingJoinWarning,
  })

  // Runtime consistency checks are owned by TaskStateMachine.checkHealth().

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
      if (runtimeDerived?.blocksQueuedDispatch) {
        void recoverCurrentTask('manual-refresh')
        return
      }

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
    [
      recoverCurrentTask,
      resetStreamingState,
      runtimeDerived?.blocksQueuedDispatch,
      toast,
      t,
      createRetryButton,
    ]
  )

  const prepareChatSend = useCallback(
    (
      message: string,
      localMessageId: string,
      immediateTaskId: number,
      effectiveRepo: Pick<
        GitRepoInfo,
        'git_url' | 'git_repo' | 'git_repo_id' | 'git_domain'
      > | null,
      sendOptions?: { interactiveFormAnswer?: InteractiveFormAnswerPayload }
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
        task_id: currentTaskId ?? undefined,
        model_id: modelId,
        force_override_bot_model: Boolean(modelId),
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
        project_id: currentTaskId ? undefined : projectId,
        additional_skills:
          snapshotAdditionalSkills && snapshotAdditionalSkills.length > 0
            ? snapshotAdditionalSkills
            : undefined,
        generate_params: generateParams,
        interactive_form_answer: sendOptions?.interactiveFormAnswer
          ? {
              ...sendOptions.interactiveFormAnswer,
              message: messageWithQueueContent,
            }
          : undefined,
      }

      const contextOptions: ContextSendOptions = {
        pendingUserMessage: messageWithQueueContent,
        pendingAttachments: snapshotAttachments,
        pendingContexts: pendingContexts.length > 0 ? pendingContexts : undefined,
        immediateTaskId,
        currentUserId: user?.id,
        onMessageSent: (_localMessageId: string, completedTaskId: number) => {
          if (completedTaskId > 0) {
            setPendingTaskId(completedTaskId)
          }

          if (completedTaskId && !currentTaskId && onTaskCreated) {
            onTaskCreated(completedTaskId)
          }

          if (completedTaskId && !currentTaskId) {
            if (taskType === 'knowledge' && knowledgeBaseId) {
              navigateToKnowledgeTask(completedTaskId, knowledgeBaseId)
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
        options: contextOptions,
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
      currentTaskId,
      selectedTaskDetail,
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
      navigateToKnowledgeTask,
      refreshTasks,
      projectId,
      refreshProjects,
      markTaskAsViewed,
      handleSendError,
      setPendingTaskId,
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

      if (currentTaskId) {
        void refreshSelectedTaskDetail()
      }

      setTimeout(() => scrollToBottom(true), 0)
    },
    [contextSendMessage, refreshSelectedTaskDetail, scrollToBottom, currentTaskId, setPendingTaskId]
  )

  const activeTaskId = currentTaskId && currentTaskId > 0 ? currentTaskId : null
  const isRuntimeBlockingQueue = runtimeDerived?.blocksQueuedDispatch ?? false
  const isActiveTaskBlocked = isMachineStreaming || hasPendingUserMessage || isRuntimeBlockingQueue
  const canQueueMessage = Boolean(
    activeTaskId && (isStreaming || hasPendingUserMessage || runtimeDerived?.canQueueMessage)
  )
  const canSendGuidance = Boolean(
    activeTaskId && isChatShell(selectedTeam) && activeStreamSubtaskId
  )

  const getActiveSubtaskId = useCallback(() => {
    return typeof activeStreamSubtaskId === 'number' ? activeStreamSubtaskId : null
  }, [activeStreamSubtaskId])

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
  } = useGuidanceQueue({
    taskId: activeTaskId,
    isGuidanceAllowed: canSendGuidance,
    expirationMessage: t('chat:guidance.expired'),
  })

  useGuidanceSocketHandlers({
    taskId: activeTaskId,
    registerChatHandlers,
    markGuidanceApplied,
    markGuidanceExpired,
    expiredMessage: t('chat:guidance.expired'),
  })

  const dispatchQueuedMessage = useCallback(
    async (queuedMessage: QueuedMessage<PreparedChatSend>) => {
      const prepared = queuedMessage.snapshot
      await sendPreparedChatMessage(prepared, { onError: undefined })
    },
    [sendPreparedChatMessage]
  )

  const handleQueuedDispatchError = useCallback(
    (queuedMessage: QueuedMessage<PreparedChatSend>, error: Error) => {
      const retryQueuedMessage = () => {
        retryQueuedMessageRef.current?.(queuedMessage.id)
      }

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
    [t, toast]
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

  useQueuedRuntimeHealthCheck({
    taskId: activeTaskId,
    queuedMessages: activeTaskQueue,
    blocksQueuedDispatch: runtimeDerived?.blocksQueuedDispatch ?? false,
    isStreaming: isMachineStreaming,
    hasPendingUserMessage,
    recoverCurrentTask: () => recoverCurrentTask('queued-message-blocked'),
  })

  const cancelQueuedMessage = useCallback(
    (id: string) => {
      const queuedMessage = activeTaskQueue.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending') return

      cancelMessage(id)

      const restoredMessage = queuedMessage.snapshot.sourceMessage || queuedMessage.displayMessage
      const currentInput = taskInputMessage.trim()
      setTaskInputMessage(
        currentInput && currentInput !== restoredMessage
          ? `${restoredMessage}\n\n${taskInputMessage}`
          : restoredMessage
      )
    },
    [activeTaskQueue, cancelMessage, setTaskInputMessage, taskInputMessage]
  )

  const editQueuedMessage = useCallback(
    (id: string) => {
      cancelQueuedMessage(id)
    },
    [cancelQueuedMessage]
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

  const editGuidanceMessage = useCallback(
    (id: string) => {
      const guidance = activeGuidanceQueue.find(message => message.guidanceId === id)
      if (!guidance || guidance.status === 'sending') return

      cancelGuidance(id)
      const currentInput = taskInputMessage.trim()
      setTaskInputMessage(
        currentInput && currentInput !== guidance.content
          ? `${guidance.content}\n\n${taskInputMessage}`
          : guidance.content
      )
    },
    [activeGuidanceQueue, cancelGuidance, setTaskInputMessage, taskInputMessage]
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
    async (
      overrideMessage?: string,
      sendOptions?: { interactiveFormAnswer?: InteractiveFormAnswerPayload }
    ) => {
      const message =
        overrideMessage !== undefined ? overrideMessage.trim() : taskInputMessage.trim()
      const hasAttachments = attachments.length > 0
      if (!message && !hasAttachments && !shouldHideChatInput) return

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

      const immediateTaskId = currentTaskId || -Date.now()
      const localMessageId = generateMessageId('user')
      const prepared = prepareChatSend(
        message,
        localMessageId,
        immediateTaskId,
        effectiveRepo,
        sendOptions
      )

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

      setTaskInputMessage('')
      resetAttachment()
      resetContexts?.()

      if (!currentTaskId) {
        setPendingTaskId(immediateTaskId)
      }

      try {
        await sendPreparedChatMessage(prepared)
      } catch (err) {
        handleSendError(err as Error, message)
      }
    },
    [
      taskInputMessage,
      attachments.length,
      shouldHideChatInput,
      isAttachmentReadyToSend,
      toast,
      selectedRepo,
      currentTaskId,
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
      setPendingTaskId,
      sendPreparedChatMessage,
      handleSendError,
    ]
  )

  const autoForwardedExpiredGuidanceRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    for (const guidance of expiredGuidance) {
      if (autoForwardedExpiredGuidanceRef.current.has(guidance.guidanceId)) continue

      autoForwardedExpiredGuidanceRef.current.add(guidance.guidanceId)
      removeExpiredGuidance(guidance.guidanceId)
      void handleSendMessage(guidance.content)
    }
  }, [expiredGuidance, handleSendMessage, removeExpiredGuidance])

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
          markGuidanceFailed(guidanceId, response.error || t('chat:guidance.send_failed'))
          return
        }

        markGuidanceQueued(guidanceId)
        return
      } catch (error) {
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
        const immediateTaskId = currentTaskId || -Date.now()

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
            task_id: currentTaskId ?? undefined,
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
              if (completedTaskId && !currentTaskId && onTaskCreated) {
                onTaskCreated(completedTaskId)
              }

              if (completedTaskId && !currentTaskId) {
                if (taskType === 'knowledge' && knowledgeBaseId) {
                  navigateToKnowledgeTask(completedTaskId, knowledgeBaseId)
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

        if (currentTaskId) {
          void refreshSelectedTaskDetail()
        }

        setTimeout(() => scrollToBottom(true), 0)
      } catch (err) {
        handleSendError(err as Error, message)
      }
    },
    [
      shouldHideChatInput,
      isAttachmentReadyToSend,
      toast,
      selectedTeam,
      currentTaskId,
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
      setPendingTaskId,
      setTaskInputMessage,
      externalApiParams,
      onTaskCreated,
      t,
      effectiveRequiresWorkspace,
      projectId,
      refreshProjects,
      navigateToKnowledgeTask,
    ]
  )

  handleSendMessageRef.current = handleSendMessage

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

      if (!currentTaskId) {
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
          'task.id': currentTaskId.toString(),
          'subtask.id': message.subtaskId.toString(),
          ...(selectedModel && { 'model.id': selectedModel.name }),
        },
        async () => {
          try {
            const modelId =
              selectedModel?.name === DEFAULT_MODEL_NAME ? undefined : selectedModel?.name
            const modelType = modelId ? selectedModel?.type : undefined

            const result = await retryMessage(
              currentTaskId,
              message.subtaskId!,
              modelId,
              modelType,
              Boolean(modelId)
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
    [retryMessage, currentTaskId, selectedModel, t, toast, traceAction]
  )

  // Handle retry with a specific model (from error card recommendation)
  const handleRetryWithModel = useCallback(
    async (message: { subtaskId?: number }, model: UnifiedModel) => {
      if (!message.subtaskId || !currentTaskId) {
        return false
      }

      try {
        const result = await retryMessage(
          currentTaskId,
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
          void refreshSelectedTaskDetail()
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
      currentTaskId,
      setSelectedModel,
      setForceOverride,
      refreshSelectedTaskDetail,
      t,
      toast,
    ]
  )

  // Handle cancel task
  const handleCancelTask = useCallback(async () => {
    if (!currentTaskId) return false

    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Cancel operation timed out')), 60000)
      })

      await Promise.race([taskApis.cancelTask(currentTaskId), timeoutPromise])

      toast({
        title: 'Task cancelled successfully',
        description: 'The task has been cancelled.',
      })

      refreshTasks()
      void refreshSelectedTaskDetail()
      return true
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
        void refreshSelectedTaskDetail()
      }
      return false
    }
  }, [currentTaskId, toast, refreshTasks, refreshSelectedTaskDetail])

  return {
    // Stream state
    pendingTaskId,
    isStreaming,
    isStopping,
    hasPendingUserMessage,
    canQueueMessage,
    canCancelTask: runtimeDerived?.canCancelTask,
    queuedMessageCount: activeTaskQueue.length,
    queuedMessages,
    cancelQueuedMessage,
    editQueuedMessage,
    sendQueuedAsGuidance,
    canSendGuidance,
    guidanceMessages,
    expiredGuidanceMessages,
    cancelGuidance,
    editGuidanceMessage,
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
  }
}

export default useChatStreamHandlers
