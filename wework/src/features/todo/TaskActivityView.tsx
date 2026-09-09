import { resolveMessageRunStatus, backendTaskExecution } from './taskActivityMessageUtils'
import {
  ChatMessage,
  TaskExecutionStatusControl,
  type ExecutionTaskSummary,
} from './TaskActivityMessage'
import { ArrowDownUp, Hash, LoaderCircle, MessageSquareText, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { createProjectChatAgentApi } from '@/api/projectChatAgents'
import type { Attachment, ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  ChatInput,
  type ProjectChatControls,
  type ProjectWorkControls,
} from '@/components/chat/ChatInput'
import { ConversationQueuePanel } from '@/components/chat/ConversationQueuePanel'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { DESKTOP_MESSAGE_LIST_CLASS } from '@/components/layout/desktopChatLayout'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchModels } from '@/features/workbench/useWorkbenchModels'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import {
  cacheRuntimeConversationQueuedMessagesByKey,
  getRuntimeConversationQueuedMessagesByKey,
} from '@/features/workbench/runtimeConversationCache'
import { persistAttachmentReferences } from '@/lib/attachments'
import { openExternalUrl } from '@/lib/external-links'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import { mergeProjectChatMessages, startTaskAiRun } from './taskAiExecution'
import { RuntimeTaskExecutionOverlay } from './RuntimeTaskExecutionOverlay'
import { CardCommentComposer, type CardCommentSendResult } from './CardCommentComposer'
import { isExecutionFailed } from './executionStatus'
import { taskActivityExecutionConfig } from './taskActivityExecutionConfig'

interface TaskActivityViewProps {
  client?: ProjectChatClient
  project: CloudProject
  task: CloudLoopItem
  currentUserId?: string | number
  onTaskUpdated?: (task: CloudLoopItem) => void
  projectChatAgentApi?: ReturnType<typeof createProjectChatAgentApi>
  localProjects?: ProjectWithTasks[]
  // rail mode: fill a fixed-height side column with an internally scrolling
  // message list and a composer pinned to the bottom
  rail?: boolean
  linear?: boolean
  workflowManagerRunId?: string | null
  onWorkflowManagerExecutionChange?: (action: (() => void) | null) => void
  onWorkflowManagerFinished?: () => void
  taskBindings?: LoopItemTaskBinding[]
  onOpenTask?: (task: LoopItemTaskBinding) => void
  onRefreshTaskBindings?: () => void | Promise<void>
}

interface TaskCardQueuedReply extends RuntimePaneQueuedMessage {
  selectedModelName?: string
}

interface TaskCardDispatchResult extends CardCommentSendResult {
  persisted: boolean
}

export function TaskActivityView({
  client,
  project,
  task,
  currentUserId,
  onTaskUpdated,
  projectChatAgentApi,
  localProjects = [],
  rail = false,
  linear = false,
  workflowManagerRunId = null,
  onWorkflowManagerExecutionChange,
  onWorkflowManagerFinished,
  taskBindings = [],
  onOpenTask,
  onRefreshTaskBindings,
}: TaskActivityViewProps) {
  const { t } = useTranslation('common')
  const { services, state, createProjectRuntimeTask, cancelRuntimeTask, sendRuntimePaneMessage } =
    useWorkbenchPaneContext()
  // Local project spaces keep their board, comments and runs in the local
  // executor; every delivery/approval call must route to the project's space
  // API instead of always hitting the cloud backend.
  const projectLocation = (project as { location?: 'local' | 'cloud' }).location
  const projectDeliveryApi =
    projectLocation === 'local'
      ? (services.projectSpaceApis?.local ?? services.deliveryApi)
      : (services.projectSpaceApis?.cloud ?? services.deliveryApi)
  const taskAiServices = useMemo(
    () => ({
      deliveryApi: projectDeliveryApi,
      chatStream: services.chatStream,
    }),
    [projectDeliveryApi, services.chatStream]
  )
  // The code project shown on the task page: the runtime code task bound to
  // this board task. Used as the default parent-comment execution project.
  const taskPageProject = useMemo(() => {
    const deviceId = task.ai_state?.runtime_device_id
    const runtimeTaskId = task.ai_state?.runtime_task_id
    if (!deviceId || !runtimeTaskId || !state.runtimeWork) return null
    for (const projectWork of state.runtimeWork.projects) {
      for (const workspace of projectWork.deviceWorkspaces) {
        if (
          workspace.deviceId === deviceId &&
          workspace.projectId != null &&
          workspace.tasks.some(item => item.taskId === runtimeTaskId)
        ) {
          return localProjects.find(project => project.id === workspace.projectId) ?? null
        }
      }
    }
    return null
  }, [
    localProjects,
    state.runtimeWork,
    task.ai_state?.runtime_device_id,
    task.ai_state?.runtime_task_id,
  ])
  const [executionDetail, setExecutionDetail] = useState<{
    address: RuntimeTaskAddress
    senderName: string
    runId: string | null
    modelName: string | null
    runStatus: string | null
  } | null>(null)
  const executionConfig = useMemo(() => taskActivityExecutionConfig(task), [task])
  const defaultActivityModel = useCallback(
    () =>
      executionConfig?.model
        ? {
            modelName: executionConfig.model,
            modelType: executionConfig.model_type,
            options: executionConfig.model_options,
          }
        : null,
    [executionConfig]
  )
  const modelSelection = useWorkbenchModels({
    api: services.modelApi,
    locked: false,
    scopeKey: `task-activity-${project.id}:${task.id}`,
    persistSelection: false,
    defaultSelectionConfig: defaultActivityModel,
    fallbackWhenConfiguredModelUnavailable: false,
  })
  const attachmentSelection = useWorkbenchAttachments({
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
    scopeKey: `task-activity-${project.id}:${task.id}`,
  })
  const {
    models: availableModels,
    selectedModel,
    selectedModelOptions,
    setSelectedModel,
    setSelectedModelOption,
  } = modelSelection
  const commentProjectChat = useMemo<ProjectChatControls>(
    () => ({
      scopeKey: `task-activity-${project.id}:${task.id}`,
      models: availableModels,
      skills: [],
      selectedModel,
      activeModel: null,
      selectedModelOptions,
      isModelSelectionReady: true,
      trialTemplates: [],
      selectedSkills: [],
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      isOptionsLocked: false,
      setSelectedModel,
      setSelectedModelOption,
      toggleSkill: () => {},
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
      listLocalSkills: async () => [],
      listLocalApps: async () => [],
    }),
    [
      attachmentSelection,
      availableModels,
      project.id,
      task.id,
      selectedModel,
      selectedModelOptions,
      setSelectedModel,
      setSelectedModelOption,
    ]
  )
  const [messages, setMessages] = useState<ProjectChatMessage[]>([])
  const requestedTaskBindingAddresses = useRef(new Set<string>())
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [chatCurrentUserId, setChatCurrentUserId] = useState<string | null>(null)
  const [cardAiErrors, setCardAiErrors] = useState<Record<string, string>>({})
  const [newCommentDraft, setNewCommentDraft] = useState('')
  const [selectedCommentProjectId, setSelectedCommentProjectId] = useState<number | ''>(
    executionConfig?.workspace_binding ? '' : (taskPageProject?.id ?? '')
  )
  const [loading, setLoading] = useState(Boolean(client))
  const [sending, setSending] = useState(false)
  const [cancellingMessageId, setCancellingMessageId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cardQueuedReplies, setCardQueuedReplies] = useState<Record<string, TaskCardQueuedReply[]>>(
    {}
  )
  const listRef = useRef<HTMLDivElement>(null)
  const followCardRef = useRef<string | null>(null)
  const refreshedRunIds = useRef(new Set<string>())
  const refreshedWorkflowManagerMessageIds = useRef(new Set<string>())
  const queuedCardReplyInFlightRef = useRef<string | null>(null)
  const compact = rail || linear

  const taskAiStatus = task.ai_state?.status
  const taskAiMessageId = task.ai_state?.project_chat_message_id
  const taskAiRuntimeDeviceId = task.ai_state?.runtime_device_id
  const taskAiRuntimeTaskId = task.ai_state?.runtime_task_id
  const workflowManagerMessage = useMemo(
    () =>
      workflowManagerRunId
        ? messages
            .filter(
              message => String(message.metadata.automation_run_id ?? '') === workflowManagerRunId
            )
            .at(-1)
        : undefined,
    [messages, workflowManagerRunId]
  )
  const workflowManagerRuntimeAddress = useMemo(() => {
    const address = workflowManagerMessage?.runtimeAddress
    if (!address?.deviceId || !address.taskId) return null
    return address
  }, [workflowManagerMessage])
  const workflowManagerBackendExecution = useMemo(
    () => (workflowManagerMessage ? backendTaskExecution(workflowManagerMessage) : null),
    [workflowManagerMessage]
  )
  const openWorkflowManagerExecution = useCallback(() => {
    if (!workflowManagerMessage) return
    if (workflowManagerRuntimeAddress) {
      setExecutionDetail({
        address: workflowManagerRuntimeAddress,
        senderName: workflowManagerMessage.sender.name,
        runId:
          typeof workflowManagerMessage.metadata.run_id === 'string'
            ? workflowManagerMessage.metadata.run_id
            : null,
        modelName:
          typeof workflowManagerMessage.metadata.model === 'string'
            ? workflowManagerMessage.metadata.model
            : null,
        runStatus: resolveMessageRunStatus(task.ai_state, workflowManagerMessage),
      })
      return
    }
    if (workflowManagerBackendExecution) {
      void openExternalUrl(workflowManagerBackendExecution.executionUrl)
      return
    }
    const card = listRef.current?.querySelector<HTMLElement>(
      `[data-testid="cloud-task-activity-card-${workflowManagerMessage.messageId}"]`
    )
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [
    task.ai_state,
    workflowManagerBackendExecution,
    workflowManagerMessage,
    workflowManagerRuntimeAddress,
  ])

  useEffect(() => {
    if (!onWorkflowManagerExecutionChange) return
    onWorkflowManagerExecutionChange(workflowManagerMessage ? openWorkflowManagerExecution : null)
    return () => onWorkflowManagerExecutionChange(null)
  }, [onWorkflowManagerExecutionChange, openWorkflowManagerExecution, workflowManagerMessage])

  useEffect(() => {
    if (!workflowManagerMessage || !onWorkflowManagerFinished) return
    if (!['completed', 'failed', 'cancelled', 'canceled'].includes(workflowManagerMessage.status)) {
      return
    }
    if (refreshedWorkflowManagerMessageIds.current.has(workflowManagerMessage.messageId)) return
    refreshedWorkflowManagerMessageIds.current.add(workflowManagerMessage.messageId)
    onWorkflowManagerFinished()
  }, [onWorkflowManagerFinished, workflowManagerMessage])

  useEffect(() => {
    const agentApi = projectChatAgentApi ?? services.projectChatAgentApi
    if (!agentApi) return
    void agentApi
      .list(project.id)
      .then(setAgents)
      .catch(cause => {
        setError(
          cause instanceof Error ? cause.message : t('workbench.project_chat_agents_load_failed')
        )
      })
  }, [project.id, projectChatAgentApi, services.projectChatAgentApi, t])

  useEffect(() => {
    if (!client) {
      return
    }
    let active = true
    let unsubscribe: (() => void) | undefined
    void client
      .subscribe(
        project.id,
        task.id,
        0,
        message => {
          if (active) setMessages(current => mergeProjectChatMessages(current, [message]))
        },
        chunk => {
          if (active) setMessages(current => appendAgentChunk(current, chunk))
        }
      )
      .then(subscription => {
        if (!active) {
          subscription.unsubscribe()
          return
        }
        unsubscribe = subscription.unsubscribe
        setChatCurrentUserId(subscription.snapshot.currentUserId)
        setMessages(current => mergeProjectChatMessages(current, subscription.snapshot.messages))
        setLoading(false)
      })
      .catch(cause => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : t('workbench.project_chat_load_failed'))
        setLoading(false)
      })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [client, project.id, t, task.id])

  // Newest parent comments render at the top, so newly sent comments are
  // visible without scrolling the list to its end.
  const scrollTaskCommentsToTop = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const scroller = resolveTaskCommentScrollContainer(listRef.current, linear)
      if (scroller) {
        if (typeof scroller.scrollTo === 'function') {
          scroller.scrollTo({ top: 0, behavior })
        } else {
          scroller.scrollTop = 0
        }
      }
    },
    [linear]
  )

  // Card replies grow inside their own card; keep the card's bottom visible
  // (where the new reply and the streaming AI response appear) instead of
  // jumping to the end of the whole comment list.
  const revealCardBottom = useCallback(
    (cardId: string, behavior: ScrollBehavior = 'auto') => {
      const card = listRef.current?.querySelector<HTMLElement>(
        `[data-testid="cloud-task-activity-card-${cardId}"]`
      )
      const scroller = resolveTaskCommentScrollContainer(listRef.current, linear)
      if (!card || !scroller) return
      const scrollerRect = scroller.getBoundingClientRect()
      const cardRect = card.getBoundingClientRect()
      if (cardRect.bottom > scrollerRect.bottom) {
        scroller.scrollTo({
          top: scroller.scrollTop + cardRect.bottom - scrollerRect.bottom + 12,
          behavior,
        })
      }
    },
    [linear]
  )

  useEffect(() => {
    const scroller = resolveTaskCommentScrollContainer(listRef.current, linear)
    if (!scroller) return
    const updateFollowState = () => {
      if (followCardRef.current) {
        const card = listRef.current?.querySelector<HTMLElement>(
          `[data-testid="cloud-task-activity-card-${followCardRef.current}"]`
        )
        if (!card) {
          followCardRef.current = null
          return
        }
        const cardBottom = card.getBoundingClientRect().bottom
        const scrollerBottom = scroller.getBoundingClientRect().bottom
        if (cardBottom > scrollerBottom + 24) followCardRef.current = null
        return
      }
    }
    scroller.addEventListener('scroll', updateFollowState, { passive: true })
    return () => scroller.removeEventListener('scroll', updateFollowState)
  }, [compact, linear, loading, messages.length])

  useEffect(() => {
    if (
      !projectDeliveryApi ||
      typeof projectDeliveryApi.getLoopItem !== 'function' ||
      task.status === 'completed'
    ) {
      return
    }
    const terminalResponse = messages.find(message => {
      if (message.taskId !== task.id || message.sender.type !== 'agent') return false
      if (message.status !== 'completed' && message.status !== 'failed') return false
      return !refreshedRunIds.current.has(message.messageId)
    })
    if (!terminalResponse) {
      if (taskAiStatus === 'running') {
        console.info('[Wework] Task activity waiting for terminal AI message', {
          taskId: task.id,
          taskStatus: task.status,
          aiStatus: taskAiStatus,
          aiMessageId: taskAiMessageId,
          runtimeDeviceId: taskAiRuntimeDeviceId,
          runtimeTaskId: taskAiRuntimeTaskId,
          agentMessages: messages
            .filter(message => message.taskId === task.id && message.sender.type === 'agent')
            .map(message => ({
              messageId: message.messageId,
              status: message.status,
              runtimeTaskId: message.runtimeAddress?.taskId,
            })),
        })
      }
      return
    }
    refreshedRunIds.current.add(terminalResponse.messageId)
    console.info('[Wework] Task activity terminal AI message received; refreshing task', {
      taskId: task.id,
      messageId: terminalResponse.messageId,
      messageStatus: terminalResponse.status,
      runtimeDeviceId: terminalResponse.runtimeAddress?.deviceId,
      runtimeTaskId: terminalResponse.runtimeAddress?.taskId,
    })
    void projectDeliveryApi
      .getLoopItem(task.id)
      .then(updated => {
        console.info('[Wework] Task activity refreshed task after terminal AI message', {
          taskId: updated.id,
          taskStatus: updated.status,
          aiStatus: updated.ai_state?.status,
          aiMessageId: updated.ai_state?.project_chat_message_id,
          runtimeTaskId: updated.ai_state?.runtime_task_id,
        })
        onTaskUpdated?.(updated)
      })
      .catch(cause => {
        setError(cause instanceof Error ? cause.message : t('workbench.project_chat_load_failed'))
      })
  }, [
    messages,
    onTaskUpdated,
    projectDeliveryApi,
    t,
    task.id,
    task.status,
    taskAiMessageId,
    taskAiRuntimeDeviceId,
    taskAiRuntimeTaskId,
    taskAiStatus,
  ])

  const threadMessages = useMemo(
    () => messages.filter(message => message.taskId === task.id),
    [messages, task]
  )

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (followCardRef.current) {
        revealCardBottom(followCardRef.current)
        const rootId = followCardRef.current
        const followedRoot = threadMessages.find(message => message.messageId === rootId)
        const followed = followedRoot
          ? {
              root: followedRoot,
              replies: threadMessages.filter(message => message.rootMessageId === rootId),
            }
          : null
        if (!followed) {
          followCardRef.current = null
          return
        }
        const lastRun = [followed.root, ...followed.replies]
          .filter(message => message.sender.type === 'agent')
          .at(-1)
        if (
          lastRun &&
          ['completed', 'failed', 'interrupted', 'stalled', 'cancelled', 'canceled'].includes(
            lastRun.status
          )
        ) {
          followCardRef.current = null
        }
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [compact, loading, messages, revealCardBottom, threadMessages])

  const assignedAgent = useMemo(
    () => agents.find(agent => agent.id === task.assignee_agent_id && agent.status === 'active'),
    [agents, task.assignee_agent_id]
  )
  // Comment execution workspace is an explicit per-run choice. Robot records
  // no longer provide an implicit device or workspace fallback.
  const effectiveCommentProject =
    selectedCommentProjectId !== ''
      ? (localProjects.find(project => project.id === selectedCommentProjectId) ?? null)
      : null
  const commentProjectWork = useMemo<ProjectWorkControls>(
    () => ({
      projects: localProjects,
      devices: state.devices,
      runtimeWork: state.runtimeWork,
      currentProject: effectiveCommentProject,
      currentProjectId: effectiveCommentProject?.id,
      currentStandaloneDeviceId: null,
      selectedDeviceWorkspaceId: null,
      pendingProjectWorkspaceProjectId: null,
      executionMode: 'current_workspace',
      executionModeLocked: true,
      showProjectClearButton: selectedCommentProjectId !== '',
      onSelectProject: projectId => setSelectedCommentProjectId(projectId ?? ''),
      onSelectStandaloneDevice: () => setSelectedCommentProjectId(''),
      onSelectProjectWorkspace: projectId => setSelectedCommentProjectId(projectId),
      onExecutionModeChange: () => {},
    }),
    [
      effectiveCommentProject,
      localProjects,
      selectedCommentProjectId,
      state.devices,
      state.runtimeWork,
    ]
  )
  const activeUserId = currentUserId ?? chatCurrentUserId
  const isBotCreator = assignedAgent
    ? String(assignedAgent.createdByUserId ?? '') === String(activeUserId ?? '')
    : false
  const canApproveCurrentRun = task.can_approve === true || isBotCreator
  const awaitingApproval = task.execution_state === 'waiting_approval'
  const rawExecutionStatus = task.execution_state ?? task.ai_state?.status
  const aiTerminalFailure = isExecutionFailed(rawExecutionStatus)
  useEffect(() => {
    if (!onRefreshTaskBindings) return
    const missingAddress = messages
      .flatMap(message =>
        message.sender.type === 'agent' && message.runtimeAddress ? [message.runtimeAddress] : []
      )
      .find(
        address =>
          !taskBindings.some(
            binding => binding.device_id === address.deviceId && binding.task_id === address.taskId
          ) && !requestedTaskBindingAddresses.current.has(`${address.deviceId}:${address.taskId}`)
      )
    if (!missingAddress) return
    const key = `${missingAddress.deviceId}:${missingAddress.taskId}`
    requestedTaskBindingAddresses.current.add(key)
    void Promise.resolve(onRefreshTaskBindings()).catch(() => {
      requestedTaskBindingAddresses.current.delete(key)
    })
  }, [messages, onRefreshTaskBindings, taskBindings])
  const commentCards = useMemo(() => {
    const ordered: { root: ProjectChatMessage; replies: ProjectChatMessage[] }[] = []
    const byRoot = new Map<string, { root: ProjectChatMessage; replies: ProjectChatMessage[] }>()
    for (const message of threadMessages) {
      const rootId = message.rootMessageId ?? message.messageId
      if (!rootId || rootId === message.messageId) {
        const card = { root: message, replies: [] }
        byRoot.set(message.messageId, card)
        ordered.push(card)
      } else {
        const card = byRoot.get(rootId)
        if (card) {
          card.replies.push(message)
        } else {
          const orphan = { root: message, replies: [] }
          byRoot.set(rootId, orphan)
          ordered.push(orphan)
        }
      }
    }
    // Newest parent comment first; replies stay chronological inside each card.
    return ordered.sort((left, right) => right.root.sequenceNumber - left.root.sequenceNumber)
  }, [threadMessages])

  const cardQueueScopeKey = useCallback(
    (rootId: string) =>
      `task-activity:${projectLocation ?? 'cloud'}:${project.id}:${task.id}:${rootId}`,
    [project.id, projectLocation, task.id]
  )

  const updateCardQueuedReplies = useCallback(
    (rootId: string, update: (current: TaskCardQueuedReply[]) => TaskCardQueuedReply[]) => {
      const scopeKey = cardQueueScopeKey(rootId)
      const current = getRuntimeConversationQueuedMessagesByKey(scopeKey) as TaskCardQueuedReply[]
      const next = update(current)
      cacheRuntimeConversationQueuedMessagesByKey(scopeKey, next)
      setCardQueuedReplies(queues => ({ ...queues, [rootId]: next }))
    },
    [cardQueueScopeKey]
  )

  useEffect(() => {
    setCardQueuedReplies(current => {
      let changed = false
      const next = { ...current }
      for (const card of commentCards) {
        const rootId = card.root.messageId
        if (Object.prototype.hasOwnProperty.call(next, rootId)) continue
        next[rootId] = getRuntimeConversationQueuedMessagesByKey(
          cardQueueScopeKey(rootId)
        ) as TaskCardQueuedReply[]
        changed = true
      }
      return changed ? next : current
    })
  }, [cardQueueScopeKey, commentCards])

  function cardSessionAddress(card: {
    root: ProjectChatMessage
    replies: ProjectChatMessage[]
  }): { runtimeDeviceId: string; runtimeTaskId: string } | null {
    const agentRuns = [card.root, ...card.replies].filter(
      message =>
        message.sender.type === 'agent' &&
        Boolean(message.runtimeAddress?.deviceId) &&
        Boolean(message.runtimeAddress?.taskId)
    )
    const latest = agentRuns.at(-1)
    if (!latest) return null
    const deviceId = latest.runtimeAddress?.deviceId
    const runtimeTaskId = latest.runtimeAddress?.taskId
    if (!deviceId || !runtimeTaskId) return null
    return { runtimeDeviceId: deviceId, runtimeTaskId }
  }

  function cardSessionActive(card: { root: ProjectChatMessage; replies: ProjectChatMessage[] }) {
    return [card.root, ...card.replies].some(
      message =>
        message.sender.type === 'agent' &&
        (message.status === 'pending' || message.status === 'streaming')
    )
  }

  function isCustomAutomationManager(message: ProjectChatMessage): boolean {
    return (
      message.sender.type === 'agent' &&
      message.metadata.executor_type === 'automation_manager' &&
      message.metadata.manager_type === 'custom'
    )
  }

  async function continueCustomAutomationManager(
    root: ProjectChatMessage,
    trigger: ProjectChatMessage,
    address: { runtimeDeviceId: string; runtimeTaskId: string },
    attachments: Attachment[]
  ): Promise<void> {
    if (!client?.continueAutomationManager) return
    let pending: ProjectChatMessage | null = null
    try {
      pending = await client.continueAutomationManager({
        projectId: project.id,
        taskId: task.id,
        triggerMessageId: trigger.messageId,
        managerMessageId: root.messageId,
      })
      setMessages(current => mergeProjectChatMessages(current, [pending!]))
      let runtimeError: string | null = null
      const continued = await sendRuntimePaneMessage(
        {
          address: {
            deviceId: address.runtimeDeviceId,
            taskId: address.runtimeTaskId,
          },
          message: trigger.content,
          collaborationMode: 'default',
          attachmentIds: remoteAttachmentIds(attachments),
          attachments: localRuntimeAttachments(attachments),
        },
        {
          onError: message => {
            runtimeError = message
          },
        }
      )
      if (continued) return
      const error = runtimeError ?? t('workbench.project_chat_agent_start_failed')
      const failed = await client.failAgentResponse({
        projectId: project.id,
        taskId: task.id,
        messageId: pending.messageId,
        error,
      })
      setMessages(current => mergeProjectChatMessages(current, [failed]))
      setCardAiErrors(current => ({ ...current, [root.messageId]: error }))
    } catch (cause) {
      setCardAiErrors(current => ({
        ...current,
        [root.messageId]:
          cause instanceof Error ? cause.message : t('workbench.project_chat_agent_start_failed'),
      }))
    }
  }

  function existingRuntimeAddress(message: ProjectChatMessage): RuntimeTaskAddress | null {
    const address = message.runtimeAddress
    if (!address?.deviceId || !address.taskId) return null
    return findRuntimeTask(state.runtimeWork, address) ? address : null
  }

  function taskSummaryForMessage(message: ProjectChatMessage): ExecutionTaskSummary | undefined {
    const address = message.runtimeAddress
    if (
      message.sender.type !== 'agent' ||
      message.metadata.executor_type === 'automation_manager' ||
      message.metadata.conversation_only === true ||
      !address?.deviceId ||
      !address.taskId
    ) {
      return undefined
    }
    const binding = taskBindings.find(
      candidate => candidate.device_id === address.deviceId && candidate.task_id === address.taskId
    )
    if (!binding) return undefined
    const stage = task.workflow?.nodes.find(candidate => candidate.id === binding?.workflow_node_id)
    return {
      title: binding.task_title || stage?.name || task.title,
      stageName: stage?.name ?? null,
      onOpen: onOpenTask ? () => onOpenTask(binding) : undefined,
    }
  }

  async function acceptTask() {
    if (!projectDeliveryApi) return
    setError(null)
    try {
      const updated = await projectDeliveryApi.updateLoopItem(task.id, {
        version: task.version,
        status: 'completed',
      })
      onTaskUpdated?.(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.task_activity_accept_failed'))
    }
  }

  async function approveTaskRun() {
    if (!projectDeliveryApi || !project) return
    setError(null)
    try {
      const updated = await projectDeliveryApi.approveLoopItemRun(project.id, task.id, task.version)
      onTaskUpdated?.(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.task_activity_approve_failed'))
    }
  }

  async function rejectTaskRun() {
    if (!projectDeliveryApi || !project) return
    const reason = window.prompt(t('workbench.task_activity_reject_reason_prompt')) ?? undefined
    if (reason === undefined) return
    setError(null)
    try {
      const updated = await projectDeliveryApi.rejectLoopItemRun(
        project.id,
        task.id,
        task.version,
        reason.trim() || undefined
      )
      onTaskUpdated?.(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.task_activity_reject_failed'))
    }
  }

  async function stopRuntimeTask(message: ProjectChatMessage) {
    if (!message.runtimeAddress || cancellingMessageId) return
    setCancellingMessageId(message.messageId)
    setError(null)
    try {
      await cancelRuntimeTask(message.runtimeAddress)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.task_activity_stop_failed'))
    } finally {
      setCancellingMessageId(null)
    }
  }

  async function rerunTaskAi() {
    if (!client || sending) return
    setSending(true)
    setError(null)
    try {
      const lastRequestedModelName = [...messages]
        .filter(
          message => message.sender.type === 'user' && typeof message.metadata.model === 'string'
        )
        .at(-1)?.metadata.model
      const rerunModel =
        typeof lastRequestedModelName === 'string'
          ? (availableModels.find(model => model.name === lastRequestedModelName) ?? null)
          : null
      await startTaskAiRun({
        client,
        services: taskAiServices,
        runtime: { createProjectRuntimeTask, sendRuntimePaneMessage },
        project,
        task,
        executionProject: null,
        prompt:
          [...messages].reverse().find(message => message.sender.type === 'user')?.content ||
          task.description ||
          task.title,
        selectedModel: rerunModel,
        selectedModelOptions: {},
        onError: setError,
        onMessages: incoming => setMessages(current => mergeProjectChatMessages(current, incoming)),
        onTaskUpdated,
        startFailedText: t('workbench.project_chat_agent_start_failed'),
      })
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('workbench.project_chat_agent_start_failed')
      )
    } finally {
      setSending(false)
    }
  }

  async function persistConversationAttachments(attachments: Attachment[]) {
    if (projectLocation !== 'local' || !projectDeliveryApi || attachments.length === 0) return
    try {
      await projectDeliveryApi.importLoopItemAttachments(task.id, attachments)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('workbench.task_activity_attachment_persist_failed')
      )
    }
  }

  async function dispatchCardReply(
    card: {
      root: ProjectChatMessage
      replies: ProjectChatMessage[]
    },
    queuedReply: TaskCardQueuedReply
  ): Promise<TaskCardDispatchResult> {
    const rootId = card.root.messageId
    const text = queuedReply.content
    const attachments = queuedReply.attachments ?? []
    if (!client || !text) {
      return { ok: false, persisted: false, error: t('workbench.project_chat_send_failed') }
    }
    const customManager = isCustomAutomationManager(card.root)
    const customManagerAddress = customManager ? cardSessionAddress(card) : null
    if (customManager && (!client.continueAutomationManager || !customManagerAddress)) {
      return {
        ok: false,
        persisted: false,
        error: t('workbench.project_chat_agent_start_failed'),
      }
    }
    setError(null)
    let persisted = false
    try {
      const message = await client.send({
        projectId: project.id,
        taskId: task.id,
        clientMessageId: crypto.randomUUID(),
        text,
        mentions: [],
        // Card composer replies are always one-level replies under the parent
        // comment.
        replyToMessageId: rootId,
        model: null,
      })
      persisted = true
      // Card replies must never trigger the list-bottom follow: switch to
      // following this card synchronously so the message-change effect cannot
      // scroll the whole comment list to its end during the AI start.
      followCardRef.current = rootId
      setMessages(current => mergeProjectChatMessages(current, [message]))
      setCardAiErrors(current => ({ ...current, [rootId]: '' }))
      void persistConversationAttachments(attachments)
      if (customManager && customManagerAddress) {
        await continueCustomAutomationManager(card.root, message, customManagerAddress, attachments)
        revealCardBottom(rootId)
        return { ok: true, persisted: true }
      }
      {
        const nativeRun = [card.root, ...card.replies].find(
          message => message.metadata.backend_task_id && !message.runtimeAddress
        )
        if (nativeRun) {
          if (!client.continueWegentTask) {
            const message = t('workbench.project_chat_agent_start_failed')
            setCardAiErrors(current => ({ ...current, [rootId]: message }))
            return { ok: false, persisted: true, error: message }
          } else {
            try {
              const incoming = await client.continueWegentTask({
                projectId: project.id,
                taskId: task.id,
                triggerMessageId: message.messageId,
                agentId: nativeRun.agentId ?? nativeRun.sender.id,
                attachmentIds: attachments.map(attachment => attachment.id),
              })
              setMessages(current => mergeProjectChatMessages(current, [incoming]))
            } catch (cause) {
              const message =
                cause instanceof Error
                  ? cause.message
                  : t('workbench.project_chat_agent_start_failed')
              setCardAiErrors(current => ({ ...current, [rootId]: message }))
              return { ok: false, persisted: true, error: message }
            }
          }
          revealCardBottom(rootId)
          return { ok: true, persisted: true }
        }
        const started = await startTaskAiRun({
          client,
          services: taskAiServices,
          runtime: { createProjectRuntimeTask, sendRuntimePaneMessage },
          project,
          task,
          executionProject: null,
          prompt: text,
          trigger: message,
          replyTo: cardSessionAddress(card),
          threadRootId: rootId,
          attachments,
          selectedModel: null,
          selectedModelOptions: queuedReply.modelOptions ?? {},
          onError: message => setCardAiErrors(current => ({ ...current, [rootId]: message })),
          onMessages: incoming =>
            setMessages(current => mergeProjectChatMessages(current, incoming)),
          onTaskUpdated,
          startFailedText: t('workbench.project_chat_agent_start_failed'),
        })
        if (!started) {
          return {
            ok: false,
            persisted: true,
            error: t('workbench.project_chat_agent_start_failed'),
          }
        }
      }
      revealCardBottom(rootId)
      return { ok: true, persisted: true }
    } catch (cause) {
      return {
        ok: false,
        persisted,
        error: cause instanceof Error ? cause.message : t('workbench.project_chat_send_failed'),
      }
    }
  }

  async function sendCardReply(
    card: {
      root: ProjectChatMessage
      replies: ProjectChatMessage[]
    },
    text: string,
    attachments: Attachment[]
  ): Promise<CardCommentSendResult> {
    const rootId = card.root.messageId
    if (!client || !text) return { ok: false, error: t('workbench.project_chat_send_failed') }
    const hasNativeTask = [card.root, ...card.replies].some(
      message => message.metadata.backend_task_id && !message.runtimeAddress
    )
    if (!cardSessionAddress(card) && !hasNativeTask) {
      return { ok: false, error: t('workbench.task_activity_session_unavailable') }
    }
    const queuedReply: TaskCardQueuedReply = {
      id: `queued-task-card-${crypto.randomUUID()}`,
      content: text,
      status: 'queued',
      createdAt: new Date().toISOString(),
      attachments: persistAttachmentReferences(attachments),
      selectedModelName: selectedModel?.name,
      modelOptions: selectedModelOptions,
    }
    updateCardQueuedReplies(rootId, current => [...current, queuedReply])
    return { ok: true }
  }

  useEffect(() => {
    if (sending || queuedCardReplyInFlightRef.current) return
    const candidate = commentCards
      .flatMap(card => {
        if (cardSessionActive(card)) return []
        const queuedReply = (cardQueuedReplies[card.root.messageId] ?? []).find(
          message => message.status === 'queued'
        )
        return queuedReply ? [{ card, queuedReply }] : []
      })
      .sort((left, right) =>
        left.queuedReply.createdAt.localeCompare(right.queuedReply.createdAt)
      )[0]
    if (!candidate) return

    const rootId = candidate.card.root.messageId
    queuedCardReplyInFlightRef.current = candidate.queuedReply.id
    setSending(true)
    updateCardQueuedReplies(rootId, current =>
      current.map(message =>
        message.id === candidate.queuedReply.id
          ? { ...message, status: 'sending', error: undefined }
          : message
      )
    )
    void dispatchCardReply(candidate.card, candidate.queuedReply)
      .then(result => {
        updateCardQueuedReplies(rootId, current =>
          result.ok || result.persisted
            ? current.filter(message => message.id !== candidate.queuedReply.id)
            : current.map(message =>
                message.id === candidate.queuedReply.id
                  ? {
                      ...message,
                      status: 'failed',
                      error: result.error ?? t('workbench.project_chat_send_failed'),
                    }
                  : message
              )
        )
      })
      .finally(() => {
        queuedCardReplyInFlightRef.current = null
        setSending(false)
      })
    // The dispatcher intentionally uses the latest card/session snapshot selected above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardQueuedReplies, commentCards, sending, t, updateCardQueuedReplies])

  async function sendNewComment(): Promise<boolean> {
    const text = newCommentDraft.trim()
    const attachments = attachmentSelection.attachments
    if (!client || !text || sending) return false
    if (!attachmentSelection.isAttachmentReadyToSend) {
      setError(t('workbench.task_activity_attachment_uploading'))
      return false
    }
    setSending(true)
    setError(null)
    try {
      const userSelectedProject =
        selectedCommentProjectId !== ''
          ? (localProjects.find(project => project.id === selectedCommentProjectId) ?? null)
          : null
      const executionProject = userSelectedProject
      const message = await client.send({
        projectId: project.id,
        taskId: task.id,
        clientMessageId: crypto.randomUUID(),
        text,
        mentions: [],
        replyToMessageId: null,
        model: selectedModel?.name ?? null,
        ...(projectLocation === 'local' && executionProject
          ? { localProjectId: executionProject.id }
          : {}),
      })
      followCardRef.current = message.messageId
      setMessages(current => mergeProjectChatMessages(current, [message]))
      setNewCommentDraft('')
      attachmentSelection.resetAttachments()
      scrollTaskCommentsToTop()
      void persistConversationAttachments(attachments)
      {
        await startTaskAiRun({
          client,
          services: taskAiServices,
          runtime: { createProjectRuntimeTask, sendRuntimePaneMessage },
          project,
          task,
          executionProject,
          prompt: text,
          trigger: message,
          attachments,
          selectedModel,
          selectedModelOptions,
          onError: setError,
          onMessages: incoming =>
            setMessages(current => mergeProjectChatMessages(current, incoming)),
          onTaskUpdated,
          startFailedText: t('workbench.project_chat_agent_start_failed'),
        })
      }
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.project_chat_send_failed'))
    } finally {
      setSending(false)
    }
    return false
  }

  return (
    <>
      <section
        data-testid={`cloud-task-activity-${task.id}`}
        className={cn(
          rail && 'flex h-full min-h-0 flex-col max-md:block',
          linear && 'task-detail-comments',
          !compact && 'mt-8 border-t border-border pt-6'
        )}
      >
        <header
          className={cn(
            'flex min-h-8 items-center gap-3',
            rail && 'shrink-0 bg-muted/40 px-[18px] pb-[10px] pt-[14px]',
            linear && 'task-detail-comments-head'
          )}
        >
          <span
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-text-secondary',
              compact && 'hidden'
            )}
          >
            <Hash className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span
              className={cn(
                'block font-semibold text-text-primary',
                compact ? 'text-base' : 'text-sm'
              )}
            >
              {t('workbench.task_activity_title')}
            </span>
          </span>
          {compact && threadMessages.length > 0 ? (
            <span className="text-sm text-text-muted">
              {t('workbench.task_activity_count', { count: threadMessages.length })}
            </span>
          ) : null}
          <span className="flex-1" />
          {compact ? (
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary transition hover:bg-muted hover:text-text-primary"
            >
              <ArrowDownUp className="h-3.5 w-3.5" />
              最新
            </button>
          ) : null}
          <div className="task-detail-activity-tools">
            {awaitingApproval && canApproveCurrentRun ? (
              <div
                data-testid={`cloud-task-activity-approval-${task.id}`}
                className="flex items-center gap-1.5"
              >
                <button
                  type="button"
                  data-testid={`cloud-task-activity-reject-${task.id}`}
                  onClick={() => void rejectTaskRun()}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition hover:bg-muted hover:text-red-600"
                >
                  {t('workbench.task_activity_reject')}
                </button>
                <button
                  type="button"
                  data-testid={`cloud-task-activity-approve-${task.id}`}
                  onClick={() => void approveTaskRun()}
                  className="rounded-lg bg-text-primary px-3 py-1.5 text-xs font-medium text-background"
                >
                  {t('workbench.task_activity_approve')}
                </button>
              </div>
            ) : null}
            {rawExecutionStatus ? (
              <TaskExecutionStatusControl
                taskId={task.id}
                status={rawExecutionStatus}
                error={task.execution_error ?? task.ai_state?.last_error}
                note={task.execution_note}
                approvalLabel={
                  awaitingApproval && !canApproveCurrentRun
                    ? assignedAgent?.createdByUserName
                      ? t('workbench.task_activity_awaiting_approval_with_creator', {
                          name: assignedAgent.createdByUserName,
                        })
                      : t('workbench.task_activity_awaiting_approval')
                    : undefined
                }
              />
            ) : null}
            {assignedAgent &&
            (task.execution_state === 'queued' ||
              task.execution_state === 'starting' ||
              task.execution_state === 'waiting_runtime') &&
            task.status !== 'in_review' ? (
              <button
                type="button"
                data-testid={`cloud-task-activity-run-now-${task.id}`}
                title={t('workbench.task_activity_run_now')}
                disabled={!client || sending}
                onClick={() => void rerunTaskAi()}
                className="task-detail-activity-icon-button"
              >
                <LoaderCircle className="h-4 w-4" />
                <span className="sr-only">{t('workbench.task_activity_run_now')}</span>
              </button>
            ) : null}
            {task.status === 'in_review' ||
            ['completed', 'succeeded'].includes(rawExecutionStatus ?? '') ? (
              <div
                data-testid={`cloud-task-activity-review-actions-${task.id}`}
                className="flex items-center gap-1.5"
              >
                {assignedAgent ? (
                  <button
                    type="button"
                    data-testid={`cloud-task-activity-rerun-${task.id}`}
                    title={t('workbench.task_activity_rerun')}
                    disabled={!client || sending}
                    onClick={() => void rerunTaskAi()}
                    className="task-detail-activity-icon-button"
                  >
                    <RotateCcw className="h-4 w-4" />
                    <span className="sr-only">{t('workbench.task_activity_rerun')}</span>
                  </button>
                ) : null}
                {projectDeliveryApi ? (
                  <button
                    type="button"
                    data-testid={`cloud-task-activity-accept-${task.id}`}
                    onClick={() => void acceptTask()}
                    className="rounded-lg bg-text-primary px-3 py-1.5 text-xs font-medium text-background"
                  >
                    {t('workbench.task_activity_accept')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {assignedAgent && aiTerminalFailure && task.status !== 'in_review' ? (
              <button
                type="button"
                data-testid={`cloud-task-activity-rerun-${task.id}`}
                title={t('workbench.task_activity_rerun')}
                disabled={!client || sending}
                onClick={() => void rerunTaskAi()}
                className="task-detail-activity-icon-button"
              >
                <RotateCcw className="h-4 w-4" />
                <span className="sr-only">{t('workbench.task_activity_rerun')}</span>
              </button>
            ) : null}
          </div>
        </header>

        <div
          ref={listRef}
          data-testid="cloud-task-activity-list"
          className={cn(
            rail && 'min-h-0 flex-1 overflow-y-auto px-[18px] pb-4 pt-0.5',
            linear && 'task-detail-comments-list',
            !compact && 'min-h-48 py-3'
          )}
        >
          {loading ? (
            <div className="flex min-h-48 items-center justify-center text-sm text-text-muted">
              <CompositedSpinner className="mr-2 h-4 w-4" />
              {t('workbench.project_chat_loading')}
            </div>
          ) : threadMessages.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center text-center">
              <MessageSquareText className="h-8 w-8 text-text-muted" />
              <p className="mt-3 text-sm font-medium text-text-primary">
                {t('workbench.task_activity_empty')}
              </p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-text-muted">
                {t('workbench.task_activity_empty_without_ai')}
              </p>
            </div>
          ) : linear ? (
            <div className="flex flex-col">
              {commentCards.map(card => {
                const rootId = card.root.messageId
                const rootRuntimeAddress = existingRuntimeAddress(card.root)
                return (
                  <article
                    key={rootId}
                    data-testid={`cloud-task-activity-card-${rootId}`}
                    data-executor-type={String(card.root.metadata.executor_type ?? '')}
                    data-manager-type={String(card.root.metadata.manager_type ?? '')}
                    className="task-detail-comment-card"
                  >
                    <ChatMessage
                      message={card.root}
                      mine={
                        card.root.sender.type === 'user' &&
                        String(card.root.sender.id) ===
                          String(chatCurrentUserId ?? currentUserId ?? '')
                      }
                      compact
                      plain
                      taskAiState={task.ai_state}
                      taskSummary={taskSummaryForMessage(card.root)}
                      onOpenExecution={
                        rootRuntimeAddress
                          ? () =>
                              setExecutionDetail({
                                address: rootRuntimeAddress,
                                senderName: card.root.sender.name,
                                runId:
                                  typeof card.root.metadata.run_id === 'string'
                                    ? card.root.metadata.run_id
                                    : null,
                                modelName:
                                  typeof card.root.metadata.model === 'string'
                                    ? card.root.metadata.model
                                    : null,
                                runStatus: resolveMessageRunStatus(task.ai_state, card.root),
                              })
                          : undefined
                      }
                      onStopExecution={
                        rootRuntimeAddress ? () => void stopRuntimeTask(card.root) : undefined
                      }
                      stopping={cancellingMessageId === card.root.messageId}
                    />
                    {card.replies.length > 0 ? (
                      <div
                        className="task-detail-comment-replies"
                        data-testid={`cloud-task-activity-replies-${rootId}`}
                      >
                        {card.replies.map(reply => {
                          const replyRuntimeAddress = existingRuntimeAddress(reply)
                          return (
                            <ChatMessage
                              key={reply.messageId}
                              message={reply}
                              mine={
                                reply.sender.type === 'user' &&
                                String(reply.sender.id) ===
                                  String(chatCurrentUserId ?? currentUserId ?? '')
                              }
                              compact
                              plain
                              taskAiState={task.ai_state}
                              taskSummary={taskSummaryForMessage(reply)}
                              onOpenExecution={
                                replyRuntimeAddress
                                  ? () =>
                                      setExecutionDetail({
                                        address: replyRuntimeAddress,
                                        senderName: reply.sender.name,
                                        runId:
                                          typeof reply.metadata.run_id === 'string'
                                            ? reply.metadata.run_id
                                            : null,
                                        modelName:
                                          typeof reply.metadata.model === 'string'
                                            ? reply.metadata.model
                                            : null,
                                        runStatus: resolveMessageRunStatus(task.ai_state, reply),
                                      })
                                  : undefined
                              }
                              onStopExecution={
                                replyRuntimeAddress ? () => void stopRuntimeTask(reply) : undefined
                              }
                              stopping={cancellingMessageId === reply.messageId}
                            />
                          )
                        })}
                      </div>
                    ) : null}
                    <div data-testid={`cloud-task-activity-card-queue-${rootId}`}>
                      <ConversationQueuePanel
                        queuedMessages={cardQueuedReplies[rootId] ?? []}
                        guidanceMessages={[]}
                        onCancelQueuedMessage={id =>
                          updateCardQueuedReplies(rootId, current =>
                            current.filter(message => message.id !== id)
                          )
                        }
                      />
                    </div>
                    <CardCommentComposer
                      rootId={rootId}
                      projectId={project.id}
                      disabled={!client}
                      placeholder={t('workbench.task_activity_inline_placeholder')}
                      aiError={cardAiErrors[rootId] || null}
                      onSend={(text, attachments) => sendCardReply(card, text, attachments)}
                    />
                  </article>
                )
              })}
            </div>
          ) : (
            <div
              className={
                rail
                  ? 'flex flex-col divide-y divide-border/70 pb-4'
                  : cn(DESKTOP_MESSAGE_LIST_CLASS, 'flex flex-col gap-4 pb-4 pt-5')
              }
            >
              {threadMessages.map(message => {
                const runtimeAddress = existingRuntimeAddress(message)
                return (
                  <ChatMessage
                    key={message.messageId}
                    message={message}
                    mine={
                      message.sender.type === 'user' &&
                      String(message.sender.id) === String(chatCurrentUserId ?? currentUserId ?? '')
                    }
                    compact={compact}
                    taskAiState={task.ai_state}
                    taskSummary={taskSummaryForMessage(message)}
                    onOpenExecution={
                      runtimeAddress
                        ? () =>
                            setExecutionDetail({
                              address: runtimeAddress,
                              senderName: message.sender.name,
                              runId:
                                typeof message.metadata.run_id === 'string'
                                  ? message.metadata.run_id
                                  : null,
                              modelName:
                                typeof message.metadata.model === 'string'
                                  ? message.metadata.model
                                  : null,
                              runStatus: resolveMessageRunStatus(task.ai_state, message),
                            })
                        : undefined
                    }
                    onStopExecution={
                      runtimeAddress ? () => void stopRuntimeTask(message) : undefined
                    }
                    stopping={cancellingMessageId === message.messageId}
                  />
                )
              })}
            </div>
          )}
        </div>

        <footer
          className={cn(
            rail && 'shrink-0 border-t border-border bg-background px-[18px] py-3',
            linear && 'task-detail-comment-bar',
            !compact && 'pt-2'
          )}
        >
          <div className="task-detail-comment-chat-input">
            <ChatInput
              value={newCommentDraft}
              disabled={!client}
              onChange={setNewCommentDraft}
              onSubmit={() => void sendNewComment()}
              submitDisabled={!newCommentDraft.trim() || sending}
              error={error ?? (!client ? t('workbench.project_chat_cloud_required') : null)}
              placeholder={t('workbench.task_activity_new_task_placeholder')}
              variant="desktop"
              projectChat={commentProjectChat}
              projectWork={commentProjectWork}
              showProjectWorkBar={localProjects.length > 0}
              inputTestId="cloud-task-activity-composer"
            />
          </div>
        </footer>
      </section>
      {executionDetail ? (
        <RuntimeTaskExecutionOverlay
          address={executionDetail.address}
          senderName={executionDetail.senderName}
          runId={executionDetail.runId}
          modelName={executionDetail.modelName}
          runStatus={executionDetail.runStatus}
          onClose={() => setExecutionDetail(null)}
        />
      ) : null}
    </>
  )
}

function appendAgentChunk(
  current: ProjectChatMessage[],
  chunk: ProjectChatMessage
): ProjectChatMessage[] {
  const existing = current.find(message => message.messageId === chunk.messageId)
  if (!existing) return mergeProjectChatMessages(current, [chunk])
  return mergeProjectChatMessages(current, [
    {
      ...existing,
      content:
        chunk.metadata.contentMode === 'snapshot'
          ? chunk.content
          : `${existing.content}${chunk.content}`,
      status: 'streaming',
      updatedAt: chunk.updatedAt,
    },
  ])
}

function findTaskCommentScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element) return null
  let current: HTMLElement | null = element
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY
    if (
      current.scrollHeight > current.clientHeight + 1 &&
      (overflowY === 'auto' || overflowY === 'scroll')
    ) {
      return current
    }
    current = current.parentElement
  }
  return null
}

function resolveTaskCommentScrollContainer(
  element: HTMLElement | null,
  linear: boolean
): HTMLElement | null {
  return linear ? element : findTaskCommentScrollContainer(element)
}
