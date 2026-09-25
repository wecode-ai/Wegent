import { IssueManagerEvent } from './IssueManagerEvent'
import { issueActivityRole } from './issueActivityRole'
import {
  useActivityExecutionBinding,
  useActivityExecutionDisplayStatus,
} from './useActivityExecutionStatus'
import { useIssueActivityScroll } from '@wegent/collaboration/issue-detail/useIssueActivityScroll'
import { useTaskActivityRefresh } from './useTaskActivityRefresh'
import {
  dispatchTaskCardReply,
  commentAgentMentions,
  cardSessionActive as sharedCardSessionActive,
  type TaskReplyCard,
  type TaskCardDispatchResult,
} from '@wegent/collaboration/execution/taskCardReply'
import { useTaskReplyQueue } from '@wegent/collaboration/execution/useTaskReplyQueue'
import { taskReplyQueueStore } from './taskReplyQueue'
import { publishProjectSpaceTaskBindingChanged } from './projectSpaceSelection'
import { issueTaskSummaryForMessage, useIssueMentionCandidates } from '@wegent/collaboration'
import {
  IssueActivityFeed,
  IssueActivityThread,
  groupIssueActivityThreads,
  createCollaborationTranslator,
  formatIssueTimestamp,
  executionDisplayStatus,
  isExecutionActive,
  IssueStatusHistoryList,
  type SharedIssueStatusHistoryEntry,
} from '@wegent/collaboration'
import type { CollaborationAgent, CollaborationMember } from '@wegent/collaboration'
import { IssueActivityTools } from '@wegent/collaboration/issue-detail/IssueActivityTools'
import { canApproveIssueExecution } from '@wegent/collaboration/issue-detail/activityApproval'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProjectChatClient,
  ProjectChatMention,
  ProjectChatMessage,
} from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'
import { projectChatAgentWorkspaceBinding } from '@/api/projectChatAgents'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { createProjectChatAgentApi } from '@/api/projectChatAgents'
import type {
  Attachment,
  ModelSelectionConfig,
  ProjectWithTasks,
  RuntimeTaskAddress,
  UnifiedModel,
} from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import {
  ChatInput,
  type ProjectChatControls,
  type ProjectWorkControls,
} from '@/components/chat/ChatInput'
import { ConversationQueuePanel } from '@/components/chat/ConversationQueuePanel'
import { DESKTOP_MESSAGE_LIST_CLASS } from '@/components/layout/desktopChatLayout'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchModels } from '@/features/workbench/useWorkbenchModels'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import {
  getRuntimeTaskLifecycleKey,
  useRuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import {
  selectActivityRerunModel,
  mergeProjectChatMessages,
  startTaskAiRun,
} from './taskAiExecution'
import { RuntimeTaskExecutionOverlay } from './RuntimeTaskExecutionOverlay'
import { CardCommentComposer, type CardCommentSendResult } from './CardCommentComposer'
import { TaskCommentComposer } from './TaskCommentComposer'
import { useIssueExecutionCancellation } from '@wegent/collaboration/issue-detail/useIssueExecutionCancellation'
import { ChatMessage, type ExecutionTaskSummary } from './TaskActivityMessage'
import { resolveMessageRunStatus } from './taskActivityMessageUtils'
import { statusHistoryLabels } from './statusHistoryLabels'
import { memberNameById } from './todoShared'
import type { CloudProjectMember } from '@/api/deliveries'

interface TaskActivityViewProps {
  client?: ProjectChatClient
  project: CloudProject
  task: CloudLoopItem
  currentUserId?: string | number
  onTaskUpdated?: (task: CloudLoopItem) => void
  projectChatAgentApi?: ReturnType<typeof createProjectChatAgentApi>
  localProjects?: ProjectWithTasks[]
  // When true, the chat client owns the AI execution lifecycle (local project
  // spaces enqueue a robot run inside send), so the shared runtime-task start
  // flow must not run again.
  selfManagedExecution?: boolean
  // rail mode: fill a fixed-height side column with an internally scrolling
  // message list and a composer pinned to the bottom
  rail?: boolean
  linear?: boolean
  deviceNamesById?: Readonly<Record<string, string>>
  taskBindings?: LoopItemTaskBinding[]
  statusHistory?: SharedIssueStatusHistoryEntry[]
  projectMembers?: CloudProjectMember[]
  issueTimeline?: boolean
  onOpenTask?: (task: LoopItemTaskBinding) => void
  onRefreshExecutionArtifacts?: () => void | Promise<void>
  /** Project members and robots that the comment composers can mention. */
  members?: CollaborationMember[]
  agents?: CollaborationAgent[]
  /** Opens the comment list on this comment and flashes it once. */
  focusedCommentId?: string | null
}

interface ActivityExecutionDetail {
  address: RuntimeTaskAddress
  messageId?: string
  senderName: string
  runId: string | null
  modelName: string | null
  runStatus: string | null
}

type TaskCardQueuedReply = RuntimePaneQueuedMessage
const EMPTY_STATUS_HISTORY: SharedIssueStatusHistoryEntry[] = []

function TimelineReply({
  rootId,
  createdAt,
  replyLabel,
  executionMessage,
  executionTurnId,
  fallbackExecutionStatus,
  sessionBusy,
  active,
  onReply,
}: {
  rootId: string
  createdAt: string
  replyLabel: string
  executionMessage?: ProjectChatMessage
  executionTurnId?: string
  fallbackExecutionStatus?: string | null
  sessionBusy: boolean
  active: boolean
  onReply: () => void
}) {
  const { status } = useActivityExecutionDisplayStatus(executionMessage, executionTurnId)
  const displayStatus = executionDisplayStatus(status ?? fallbackExecutionStatus)
  const blocked = sessionBusy || isExecutionActive(displayStatus)
  return (
    <div className="task-detail-thread-actions">
      <time dateTime={createdAt} className="text-xs text-text-muted">
        {formatIssueTimestamp(createdAt)}
      </time>
      {!blocked ? (
        <button
          type="button"
          data-testid={`cloud-task-activity-reply-toggle-${rootId}`}
          aria-expanded={active}
          aria-controls="issue-reply-composer"
          onClick={onReply}
        >
          {replyLabel}
        </button>
      ) : null}
    </div>
  )
}

/** How long a comment keeps the "you were sent here" highlight. */
const COMMENT_FLASH_MS = 2000

function isVersionConflict(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false
  if ('status' in cause && cause.status === 409) return true
  if ('code' in cause && cause.code === 'version_conflict') return true
  return 'errorCode' in cause && cause.errorCode === 'version_conflict'
}

export function TaskActivityView({
  client,
  project,
  task,
  currentUserId,
  onTaskUpdated,
  projectChatAgentApi,
  localProjects = [],
  selfManagedExecution = false,
  rail = false,
  linear = false,
  deviceNamesById,
  taskBindings = [],
  statusHistory = EMPTY_STATUS_HISTORY,
  projectMembers = [],
  issueTimeline = false,
  onOpenTask,
  onRefreshExecutionArtifacts,
  members = [],
  agents = [],
  focusedCommentId = null,
}: TaskActivityViewProps) {
  const { t, i18n } = useTranslation('common')
  const activityTranslate = createCollaborationTranslator(
    i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  )
  const mentionCandidates = useIssueMentionCandidates(members, agents, activityTranslate)
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot()
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
  const [loadedStatusHistory, setLoadedStatusHistory] = useState<{
    taskId: string
    entries: SharedIssueStatusHistoryEntry[]
  } | null>(null)
  useEffect(() => {
    if (!issueTimeline || statusHistory.length || !projectDeliveryApi?.getLoopItem) return
    let active = true
    void projectDeliveryApi.getLoopItem(task.id).then(
      item => {
        if (active) {
          setLoadedStatusHistory({ taskId: task.id, entries: item.status_history ?? [] })
        }
      },
      () => undefined
    )
    return () => {
      active = false
    }
  }, [issueTimeline, projectDeliveryApi, statusHistory.length, task.id, task.status, task.version])
  const activityStatusHistory =
    statusHistory.length || loadedStatusHistory?.taskId !== task.id
      ? statusHistory
      : loadedStatusHistory.entries
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
  const [executionDetail, setExecutionDetail] = useState<ActivityExecutionDetail | null>(null)
  const [projectChatAgents, setProjectChatAgents] = useState<ProjectChatAgent[]>([])
  const assignedAgent = useMemo(
    () =>
      projectChatAgents.find(
        agent => agent.id === task.assignee_agent_id && agent.status === 'active'
      ),
    [projectChatAgents, task.assignee_agent_id]
  )
  // Continuing the conversation reuses the assigned robot's own model, so the
  // composer inherits its configured selection until the user picks another
  // one. An unavailable model resolves to no selection, which keeps the
  // default-model trigger instead of silently running something else.
  const assignedAgentModelSelection = useMemo<ModelSelectionConfig | null>(
    () =>
      assignedAgent?.model
        ? {
            modelName: assignedAgent.model,
            modelType: assignedAgent.modelType,
            options: assignedAgent.modelOptions ?? {},
          }
        : null,
    [assignedAgent]
  )
  const [modelSelectionOverridden, setModelSelectionOverridden] = useState(false)
  const modelSelection = useWorkbenchModels({
    api: services.modelApi,
    locked: false,
    scopeKey: `task-activity-${project.id}`,
    persistSelection: false,
    selectionConfig: assignedAgentModelSelection,
    // Stop following the robot record once this composer has its own model.
    selectionReady: !modelSelectionOverridden,
  })
  const attachmentSelection = useWorkbenchAttachments({
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
    scopeKey: `task-activity-${project.id}`,
  })
  const {
    models: availableModels,
    selectedModel,
    selectedModelOptions,
    setSelectedModel,
    setSelectedModelOption,
  } = modelSelection
  const selectCommentModel = useCallback(
    (model: UnifiedModel | null) => {
      setModelSelectionOverridden(true)
      setSelectedModel(model)
    },
    [setSelectedModel]
  )
  const selectCommentModelOption = useCallback(
    (optionId: string, value: string) => {
      setModelSelectionOverridden(true)
      setSelectedModelOption(optionId, value)
    },
    [setSelectedModelOption]
  )
  const commentProjectChat = useMemo<ProjectChatControls>(
    () => ({
      scopeKey: `task-activity-${project.id}`,
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
      setSelectedModel: selectCommentModel,
      setSelectedModelOption: selectCommentModelOption,
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
      selectCommentModel,
      selectCommentModelOption,
      selectedModel,
      selectedModelOptions,
    ]
  )
  const [messages, setMessages] = useState<ProjectChatMessage[]>([])
  const requestedTaskBindingAddresses = useRef(new Set<string>())
  const [chatCurrentUserId, setChatCurrentUserId] = useState<string | null>(null)
  const [newCommentDraft, setNewCommentDraft] = useState('')
  const [replyTarget, setReplyTarget] = useState<TaskReplyCard | null>(null)
  const replyComposerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!replyTarget) return
    replyComposerRef.current
      ?.querySelector<HTMLElement>('[contenteditable="true"], textarea')
      ?.focus()
  }, [replyTarget])
  // The code workspace the assigned robot is bound to. Only a rebound backend
  // project can be selected here; a legacy record that still needs rebinding
  // and a device-owned workspace carry no selectable project.
  const assignedAgentProjectId = useMemo(() => {
    if (!assignedAgent) return null
    const binding = projectChatAgentWorkspaceBinding(assignedAgent)
    if (binding.status !== 'ready' || binding.type !== 'backend_project') return null
    if (!localProjects.some(project => project.id === binding.projectId)) return null
    return binding.projectId
  }, [assignedAgent, localProjects])
  // The comment execution workspace stays an explicit choice: `null` means the
  // user has not chosen yet, so the composer follows the task's own execution
  // project and then the assigned robot's bound workspace. `''` records an
  // explicit "no project", so a later data refresh cannot revive a default.
  const [commentProjectChoice, setCommentProjectChoice] = useState<number | '' | null>(null)
  const selectedCommentProjectId =
    commentProjectChoice ?? taskPageProject?.id ?? assignedAgentProjectId ?? ''
  const [loading, setLoading] = useState(Boolean(client))
  const [sending, setSending] = useState(false)
  const cancellation = useIssueExecutionCancellation(
    String(task.id),
    cancelRuntimeTask,
    t('workbench.task_activity_stop_failed')
  )
  const cancellingMessageId = cancellation.stoppingMessageId
  const [error, setError] = useState<string | null>(null)
  const executionBinding = useActivityExecutionBinding(messages, executionDetail?.messageId)
  const compact = rail || linear
  const threadMessages = useMemo(
    () => messages.filter(message => message.taskId === task.id),
    [messages, task]
  )
  const { listRef, followCard, scrollTaskCommentsToBottom, revealCardBottom } =
    useIssueActivityScroll({
      messages: threadMessages,
      loading,
      linear,
      compact,
      cardTestIdPrefix: 'cloud-task-activity-card-',
    })

  // A notification can point at one comment. Land on it once, flash it, and
  // then leave the list under the reader's control.
  const [flashedCommentId, setFlashedCommentId] = useState<string | null>(null)
  const revealedCommentRef = useRef<string | null>(null)
  useEffect(() => {
    if (!focusedCommentId || revealedCommentRef.current === focusedCommentId) return
    const target = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []
    ).find(node => node.dataset.messageId === focusedCommentId)
    if (!target) return
    revealedCommentRef.current = focusedCommentId
    target.scrollIntoView?.({ block: 'center' })
    setFlashedCommentId(focusedCommentId)
  }, [focusedCommentId, listRef, threadMessages])
  useEffect(() => {
    if (!flashedCommentId) return
    const timer = window.setTimeout(() => setFlashedCommentId(null), COMMENT_FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [flashedCommentId])

  useEffect(() => {
    const agentApi = projectChatAgentApi ?? services.projectChatAgentApi
    if (!agentApi) return
    void agentApi
      .list(project.id)
      .then(setProjectChatAgents)
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

  useTaskActivityRefresh({
    task,
    messages,
    projectDeliveryApi,
    onTaskUpdated,
    onRefreshExecutionArtifacts,
    setError,
    t,
  })

  // The execution workspace resolves against the device's own projects, so a
  // project that is not available here keeps the empty placeholder instead of
  // pointing a run at a workspace this device cannot open.
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
      onSelectProject: projectId => setCommentProjectChoice(projectId ?? ''),
      onSelectStandaloneDevice: () => setCommentProjectChoice(''),
      onSelectProjectWorkspace: projectId => setCommentProjectChoice(projectId),
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
  const canApproveCurrentRun = canApproveIssueExecution(
    task.can_approve,
    assignedAgent?.createdByUserId,
    activeUserId
  )
  useEffect(() => {
    if (!onRefreshExecutionArtifacts) return
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
    void Promise.resolve(onRefreshExecutionArtifacts()).catch(() => {
      requestedTaskBindingAddresses.current.delete(key)
    })
  }, [messages, onRefreshExecutionArtifacts, taskBindings])
  const commentCards = useMemo(() => groupIssueActivityThreads(threadMessages), [threadMessages])
  const activityEntries = useMemo(() => {
    const comments = commentCards.map((card, index) => ({
      kind: 'comment' as const,
      at: card.root.createdAt,
      index,
      card,
    }))
    if (!issueTimeline) return comments
    const creation =
      task.created_at && !activityStatusHistory.some(entry => entry.trigger === 'create')
        ? [{ kind: 'created' as const, at: task.created_at, index: -1 }]
        : []
    return [
      ...creation,
      ...activityStatusHistory.map((entry, index) => ({
        kind: 'status' as const,
        at: entry.at,
        index,
        entry,
      })),
      ...comments,
    ].sort((left, right) => {
      const delta = Date.parse(left.at) - Date.parse(right.at)
      if (delta) return delta
      const order = { created: 0, status: 1, comment: 2 }
      return order[left.kind] - order[right.kind] || left.index - right.index
    })
  }, [activityStatusHistory, commentCards, issueTimeline, task.created_at])

  function cardSessionActive(card: TaskReplyCard) {
    return sharedCardSessionActive(card, address => {
      const runtime = lifecycleSnapshot.tasks.get(getRuntimeTaskLifecycleKey(address))
      return runtime?.execution.known ? runtime.derived.isBusy : undefined
    })
  }
  const replyQueue = useTaskReplyQueue({
    store: taskReplyQueueStore,
    scope: `task-activity:${projectLocation ?? 'cloud'}:${project.id}:${task.id}`,
    cards: commentCards,
    enabled: Boolean(client) && !sending,
    busy: cardSessionActive,
    dispatch: dispatchCardReply,
    sendFailedText: t('workbench.project_chat_send_failed'),
  })

  function messageRuntimeAddress(message: ProjectChatMessage): RuntimeTaskAddress | null {
    const address = message.runtimeAddress
    if (!address?.deviceId || !address.taskId) return null
    // The activity owns this address; the workbench list may not include a new run yet.
    return address
  }

  function taskSummaryForMessage(message: ProjectChatMessage): ExecutionTaskSummary | undefined {
    return issueTaskSummaryForMessage(message, taskBindings, task.title, onOpenTask)
  }

  function deviceNameForMessage(message: ProjectChatMessage): string | null {
    const deviceId = message.runtimeAddress?.deviceId
    if (!deviceId) return null
    const mappedName = deviceNamesById?.[deviceId]?.trim()
    if (mappedName) return mappedName
    return findWorkbenchDevice(state.devices, deviceId)?.name.trim() || null
  }

  async function acceptTask() {
    if (!projectDeliveryApi) return
    setError(null)
    try {
      let updated: CloudLoopItem
      try {
        updated = await projectDeliveryApi.updateLoopItem(task.id, {
          version: task.version,
          status: 'completed',
        })
      } catch (cause) {
        if (!isVersionConflict(cause)) throw cause
        const latest = await projectDeliveryApi.getLoopItem(task.id)
        updated =
          latest.status === 'completed'
            ? latest
            : await projectDeliveryApi.updateLoopItem(task.id, {
                version: latest.version,
                status: 'completed',
              })
      }
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
    if (message.runtimeAddress) await cancellation.stop(message.messageId, message.runtimeAddress)
  }

  async function rerunTaskAi() {
    if (!client || !assignedAgent || sending) return
    setSending(true)
    setError(null)
    try {
      const rerunModel = selectActivityRerunModel(messages, availableModels)
      await startTaskAiRun({
        client,
        services: taskAiServices,
        runtime: { createProjectRuntimeTask, sendRuntimePaneMessage },
        project,
        task,
        agent: assignedAgent,
        executionProject: null,
        prompt:
          task.automation?.prompt || [task.title, task.description].filter(Boolean).join('\n\n'),
        messages,
        models: availableModels,
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
    card: TaskReplyCard,
    reply: TaskCardQueuedReply
  ): Promise<TaskCardDispatchResult> {
    if (!client)
      return { ok: false, persisted: false, error: t('workbench.project_chat_send_failed') }
    setSending(true)
    try {
      const result = await dispatchTaskCardReply({
        client,
        services: taskAiServices,
        runtime: { createProjectRuntimeTask, sendRuntimePaneMessage },
        project,
        task,
        agent: assignedAgent,
        selfManagedExecution,
        card,
        reply,
        messages,
        executionProject: null,
        models: availableModels,
        onPersisted: () => {
          followCard(card.root.messageId)
          void persistConversationAttachments(reply.attachments ?? [])
        },
        onMessages: incoming => setMessages(current => mergeProjectChatMessages(current, incoming)),
        onError: error => replyQueue.setError(card.root.messageId, error),
        onTaskUpdated,
        onBindingChange: publishProjectSpaceTaskBindingChanged,
        startFailedText: t('workbench.project_chat_agent_start_failed'),
        sendFailedText: t('workbench.project_chat_send_failed'),
      })
      if (result.persisted) revealCardBottom(card.root.messageId)
      return result
    } finally {
      setSending(false)
    }
  }

  async function sendCardReply(
    card: TaskReplyCard,
    text: string,
    mentions: ProjectChatMention[],
    attachments: Attachment[]
  ): Promise<CardCommentSendResult> {
    if (!client || !text) return { ok: false, error: t('workbench.project_chat_send_failed') }
    return replyQueue.enqueue(card.root.messageId, text, attachments, mentions)
  }

  async function sendNewComment(text: string, mentions: ProjectChatMention[]): Promise<boolean> {
    const attachments = attachmentSelection.attachments
    if (!client || !text || sending) return false
    if (!attachmentSelection.isAttachmentReadyToSend) {
      setError(t('workbench.task_activity_attachment_uploading'))
      return false
    }
    setSending(true)
    setError(null)
    try {
      const executionProject = effectiveCommentProject
      const explicitMentions = commentAgentMentions(text, agents)
      const activeMentions: ProjectChatMention[] = [
        ...(explicitMentions.length || projectLocation !== 'local'
          ? explicitMentions
          : assignedAgent
            ? [{ type: 'agent' as const, id: assignedAgent.id, label: assignedAgent.name }]
            : []),
        ...mentions.filter(mention => mention.type === 'user'),
      ]
      const message = await client.send({
        projectId: project.id,
        taskId: task.id,
        clientMessageId: crypto.randomUUID(),
        text,
        mentions: activeMentions,
        replyToMessageId: null,
        model:
          projectLocation !== 'local' && client.executeTaskComment
            ? null
            : (selectedModel?.name ?? null),
        ...(projectLocation === 'local' && executionProject
          ? { localProjectId: executionProject.id }
          : {}),
      })
      followCard(message.messageId)
      setMessages(current => mergeProjectChatMessages(current, [message]))
      setNewCommentDraft('')
      attachmentSelection.resetAttachments()
      scrollTaskCommentsToBottom()
      void persistConversationAttachments(attachments)
      if (projectLocation !== 'local' && client.executeTaskComment) {
        const incoming = await client.executeTaskComment({
          projectId: project.id,
          taskId: task.id,
          triggerMessageId: message.messageId,
          attachmentIds: attachments.map(file => Number(file.id)),
        })
        setMessages(current => mergeProjectChatMessages(current, incoming))
      } else if (assignedAgent && !selfManagedExecution) {
        await startTaskAiRun({
          client,
          services: taskAiServices,
          runtime: { createProjectRuntimeTask, sendRuntimePaneMessage },
          project,
          task,
          agent: assignedAgent,
          executionProject,
          prompt: text,
          trigger: message,
          messages,
          attachments,
          models: availableModels,
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

  const renderActivityMessage = (
    message: ProjectChatMessage,
    eventOnly = false,
    hideTime = false
  ) => {
    const role = issueActivityRole(message)
    const agentRole = role
    const address = messageRuntimeAddress(message)
    const binding = address
      ? taskBindings.find(
          item => item.device_id === address.deviceId && item.task_id === address.taskId
        )
      : undefined
    return (
      <ChatMessage
        key={message.messageId}
        message={message}
        executionTurnId={executionBinding.getTurnId(message)}
        flash={message.messageId === flashedCommentId}
        mine={
          message.sender.type === 'user' &&
          String(message.sender.id) === String(chatCurrentUserId ?? currentUserId ?? '')
        }
        compact
        plain
        showInlineExecutionStatus={issueTimeline}
        agentRole={agentRole}
        allowBackendExecutionFallback={!issueTimeline}
        eventOnly={eventOnly}
        taskAiState={task.ai_state}
        executionDeviceName={deviceNameForMessage(message)}
        taskSummary={taskSummaryForMessage(message)}
        hideTime={hideTime}
        onOpenExecution={
          issueTimeline
            ? binding && onOpenTask
              ? () => onOpenTask(binding)
              : undefined
            : address
              ? () =>
                  setExecutionDetail({
                    address,
                    messageId: message.messageId,
                    senderName: message.sender.name,
                    runId:
                      typeof message.metadata.run_id === 'string' ? message.metadata.run_id : null,
                    modelName:
                      typeof message.metadata.model === 'string' ? message.metadata.model : null,
                    runStatus: resolveMessageRunStatus(task.ai_state, message),
                  })
              : undefined
        }
        onStopExecution={address ? () => void stopRuntimeTask(message) : undefined}
        stopping={cancellingMessageId === message.messageId}
      />
    )
  }

  return (
    <>
      <IssueActivityFeed
        mode={linear ? 'linear' : rail ? 'rail' : 'document'}
        testId={`cloud-task-activity-${task.id}`}
        listTestId="cloud-task-activity-list"
        listRef={listRef}
        translate={activityTranslate}
        count={issueTimeline ? activityEntries.length : threadMessages.length}
        loading={loading}
        error={cancellation.error}
        emptyDescription={
          assignedAgent
            ? activityTranslate('activity.task_activity_empty_with_ai', undefined, {
                name: assignedAgent.name,
              })
            : activityTranslate('activity.task_activity_empty_without_ai')
        }
        tools={
          <div className="flex items-center gap-2">
            <IssueActivityTools
              task={task}
              assignedAgent={assignedAgent}
              canApprove={canApproveCurrentRun}
              running={sending}
              translate={activityTranslate}
              copyText={copyTextToClipboard}
              onApprove={projectDeliveryApi ? () => void approveTaskRun() : undefined}
              onReject={projectDeliveryApi ? () => void rejectTaskRun() : undefined}
              onAccept={projectDeliveryApi ? () => void acceptTask() : undefined}
              onRun={client ? () => void rerunTaskAi() : undefined}
            />
          </div>
        }
        composer={
          <>
            {issueTimeline && replyTarget ? (
              <div
                ref={replyComposerRef}
                id="issue-reply-composer"
                className="px-3 py-2"
                data-testid="issue-reply-composer"
              >
                <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
                  <span>
                    {t('workbench.task_activity_inline_placeholder')} {replyTarget.root.sender.name}
                  </span>
                  <button
                    type="button"
                    data-testid="issue-reply-cancel"
                    onClick={() => setReplyTarget(null)}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
                <CardCommentComposer
                  rootId={replyTarget.root.messageId}
                  projectId={project.id}
                  disabled={!client}
                  placeholder={t('workbench.task_activity_inline_placeholder')}
                  aiError={replyQueue.error(replyTarget.root.messageId)}
                  mentionCandidates={mentionCandidates}
                  translate={activityTranslate}
                  onSend={async (text, mentions, attachments) => {
                    const result = await sendCardReply(replyTarget, text, mentions, attachments)
                    if (result.ok) setReplyTarget(null)
                    return result
                  }}
                />
              </div>
            ) : linear || (projectLocation !== 'local' && client?.executeTaskComment) ? (
              <TaskCommentComposer
                key={task.id}
                value={newCommentDraft}
                onChange={setNewCommentDraft}
                onSubmit={(body, mentions) => void sendNewComment(body, mentions)}
                disabled={!client}
                sending={sending}
                error={error ?? (!client ? t('workbench.project_chat_cloud_required') : null)}
                mentionCandidates={mentionCandidates}
                translate={activityTranslate}
                controls={commentProjectChat}
                projectWork={commentProjectWork}
                serverExecution={projectLocation !== 'local' && Boolean(client?.executeTaskComment)}
              />
            ) : (
              <div className="task-detail-comment-chat-input">
                <ChatInput
                  value={newCommentDraft}
                  disabled={!client}
                  onChange={setNewCommentDraft}
                  onSubmit={() => void sendNewComment(newCommentDraft.trim(), [])}
                  submitDisabled={!newCommentDraft.trim() || sending}
                  error={error ?? (!client ? t('workbench.project_chat_cloud_required') : null)}
                  placeholder={
                    assignedAgent
                      ? t('workbench.task_activity_ai_placeholder', { name: assignedAgent.name })
                      : t('workbench.task_activity_placeholder')
                  }
                  variant="desktop"
                  projectChat={commentProjectChat}
                  projectWork={commentProjectWork}
                  showProjectWorkBar={localProjects.length > 0}
                  inputTestId="cloud-task-activity-composer"
                />
              </div>
            )}
          </>
        }
      >
        {linear ? (
          <div className="flex flex-col">
            {activityEntries.map(activity => {
              if (activity.kind === 'created') {
                return (
                  <div
                    key="issue-created"
                    data-testid="cloud-task-status-created"
                    className="flex gap-3 border-b border-border/60 px-3 py-2"
                  >
                    <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-text-muted" />
                    <div className="min-w-0 flex-1 text-xs text-text-primary">
                      <span className="font-medium">
                        {task.created_by_user_name ||
                          memberNameById(projectMembers, task.created_by_user_id) ||
                          t('todo.status_history_system')}
                      </span>{' '}
                      {t('todo.status_action_create')} Issue
                      <time dateTime={activity.at} className="ml-2 text-text-muted">
                        {formatIssueTimestamp(activity.at)}
                      </time>
                    </div>
                  </div>
                )
              }
              if (activity.kind === 'status') {
                return (
                  <div
                    key={`status-${activity.index}`}
                    data-testid={`cloud-task-status-event-${activity.index}`}
                    className="flex gap-3 border-b border-border/60 px-3 py-2"
                  >
                    <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-text-muted" />
                    <div className="min-w-0 flex-1">
                      <IssueStatusHistoryList
                        entries={[activity.entry]}
                        startIndex={activity.index}
                        memberName={userId => memberNameById(projectMembers, userId)}
                        labels={statusHistoryLabels(t)}
                      />
                    </div>
                  </div>
                )
              }
              const card = activity.card
              const rootId = card.root.messageId
              const role = issueActivityRole(card.root)
              if (issueTimeline && role === 'manager') {
                const address = messageRuntimeAddress(card.root)
                const binding = address
                  ? taskBindings.find(
                      item => item.device_id === address.deviceId && item.task_id === address.taskId
                    )
                  : undefined
                return (
                  <div key={rootId}>
                    <IssueManagerEvent
                      message={card.root}
                      task={task}
                      onOpenExecution={
                        binding && onOpenTask ? () => onOpenTask(binding) : undefined
                      }
                    />
                    {card.replies.map(reply => renderActivityMessage(reply))}
                  </div>
                )
              }
              const executions = [card.root, ...card.replies].filter(
                message => message.sender.type === 'agent'
              )
              const latestExecution = executions.at(-1)
              return (
                <IssueActivityThread
                  key={rootId}
                  variant={issueTimeline ? 'timeline' : 'card'}
                  cardAttributes={{
                    'data-testid': `cloud-task-activity-card-${rootId}`,
                  }}
                  message={renderActivityMessage(card.root, false, issueTimeline)}
                  replies={
                    card.replies.length
                      ? card.replies.map(reply => renderActivityMessage(reply))
                      : null
                  }
                  repliesTestId={`cloud-task-activity-replies-${rootId}`}
                  composer={
                    <>
                      <div data-testid={`cloud-task-activity-card-queue-${rootId}`}>
                        <ConversationQueuePanel
                          queuedMessages={replyQueue.messages(rootId)}
                          guidanceMessages={[]}
                          onCancelQueuedMessage={id => replyQueue.cancel(rootId, id)}
                        />
                      </div>
                      {issueTimeline ? (
                        <TimelineReply
                          rootId={rootId}
                          createdAt={card.root.createdAt}
                          replyLabel={t('workbench.task_activity_inline_placeholder')}
                          executionMessage={latestExecution}
                          executionTurnId={
                            latestExecution
                              ? executionBinding.getTurnId(latestExecution)
                              : undefined
                          }
                          fallbackExecutionStatus={
                            latestExecution
                              ? resolveMessageRunStatus(task.ai_state, latestExecution)
                              : task.ai_state?.project_chat_message_id === rootId
                                ? task.ai_state.status
                                : null
                          }
                          sessionBusy={cardSessionActive(card)}
                          active={replyTarget?.root.messageId === rootId}
                          onReply={() => setReplyTarget(card)}
                        />
                      ) : (
                        <CardCommentComposer
                          rootId={rootId}
                          projectId={project.id}
                          disabled={!client}
                          placeholder={t('workbench.task_activity_inline_placeholder')}
                          aiError={replyQueue.error(rootId)}
                          mentionCandidates={mentionCandidates}
                          translate={activityTranslate}
                          onSend={(text, mentions, attachments) =>
                            sendCardReply(card, text, mentions, attachments)
                          }
                        />
                      )}
                    </>
                  }
                  events={
                    !issueTimeline && executions.length
                      ? executions.map(message => renderActivityMessage(message, true))
                      : null
                  }
                  eventLabel={t('workbench.task_activity_execution_count', {
                    count: executions.length,
                  })}
                  eventTestId={`task-activity-events-toggle-${rootId}`}
                />
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
              const runtimeAddress = messageRuntimeAddress(message)
              return (
                <ChatMessage
                  key={message.messageId}
                  message={message}
                  executionTurnId={executionBinding.getTurnId(message)}
                  flash={message.messageId === flashedCommentId}
                  mine={
                    message.sender.type === 'user' &&
                    String(message.sender.id) === String(chatCurrentUserId ?? currentUserId ?? '')
                  }
                  compact={compact}
                  taskAiState={task.ai_state}
                  executionDeviceName={deviceNameForMessage(message)}
                  taskSummary={taskSummaryForMessage(message)}
                  onOpenExecution={
                    runtimeAddress
                      ? () =>
                          setExecutionDetail({
                            address: runtimeAddress,
                            messageId: message.messageId,
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
                  onStopExecution={runtimeAddress ? () => void stopRuntimeTask(message) : undefined}
                  stopping={cancellingMessageId === message.messageId}
                />
              )
            })}
          </div>
        )}
      </IssueActivityFeed>
      {executionDetail ? (
        <RuntimeTaskExecutionOverlay
          key={JSON.stringify([
            executionDetail.address.deviceId,
            executionDetail.address.taskId,
            executionDetail.messageId,
          ])}
          address={
            projectLocation === 'local' || project.project_store === 'local'
              ? executionDetail.address
              : {
                  ...executionDetail.address,
                  projectSession: { projectId: String(project.id), issueId: task.id },
                }
          }
          {...executionBinding.overlay}
          senderName={executionDetail.senderName}
          runId={executionDetail.runId}
          modelName={executionDetail.modelName}
          runStatus={
            executionBinding.overlay.activityMessage
              ? resolveMessageRunStatus(task.ai_state, executionBinding.overlay.activityMessage)
              : executionDetail.runStatus
          }
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
