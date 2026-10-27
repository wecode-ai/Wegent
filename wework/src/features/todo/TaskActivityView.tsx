import { IssueManagerEvent } from './IssueManagerEvent'
import { IssueAssignmentEvent } from './IssueAssignmentEvent'
import { issueActivityTimeline } from './issueActivityTimeline'
import { useIssueActivityHistory } from './useIssueActivityHistory'
import { issueActivityRole } from './issueActivityRole'
import { useActivityExecutionBinding } from './useActivityExecutionStatus'
import { useIssueActivityScroll } from '@wegent/collaboration/issue-detail/useIssueActivityScroll'
import { useTaskActivityRefresh } from './useTaskActivityRefresh'
import { useFocusedComment } from './useFocusedComment'
import {
  dispatchTaskCardReply,
  commentAgentMentions,
  cardSessionAddress,
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
  groupIssueTimelineThreads,
  createCollaborationTranslator,
  issueThreadActivityTimestamp,
  formatIssueTimestamp,
  IssueStatusHistoryList,
  humanDispatchAssignment,
  type HumanDispatchAssignment,
  type SharedIssueStatusHistoryEntry,
  type IssueActivityThreadModel,
} from '@wegent/collaboration'
import type { CollaborationAgent, CollaborationMember } from '@wegent/collaboration'
import { IssueActivityTools } from '@wegent/collaboration/issue-detail/IssueActivityTools'
import { canApproveIssueExecution } from '@wegent/collaboration/issue-detail/activityApproval'
import { copyTextToClipboard } from '@/lib/clipboard'
import { createTaskCommentPreparer } from './prepareTaskComment'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { IssueChangeRequestBadges } from '@/features/change-requests/IssueChangeRequestBadges'
import type { CloudProjectMember } from '@/api/deliveries'

interface TaskActivityViewProps {
  commentAssignment?: import('@wegent/collaboration').CommentAssignment
  client?: ProjectChatClient
  project: CloudProject
  task: CloudLoopItem
  currentUserId?: string | number
  onTaskRead?: (task: CloudLoopItem) => void
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
  /** Changes for each navigation request, including reopening the same comment. */
  focusedCommentRequestKey?: string | null
  /**
   * Opens a task for the member a manager assigned this Issue to. A reply on a
   * thread that has no execution to continue posts its comment and then asks
   * the host to start that work item.
   */
  onStartHumanTaskFromReply?: (input: StartHumanTaskFromReplyInput) => void | Promise<void>
}

export interface StartHumanTaskFromReplyInput {
  issueId: string
  dispatch: HumanDispatchAssignment
  replyText: string
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

function boundCardSessionAddress(
  card: TaskReplyCard,
  taskBindings: LoopItemTaskBinding[]
): RuntimeTaskAddress | null {
  const address = cardSessionAddress(card)
  if (!address) return null
  const binding = taskBindings.find(
    candidate => candidate.device_id === address.deviceId && candidate.task_id === address.taskId
  )
  if (!binding) return address
  const context = binding.executionContext
  return {
    ...address,
    ...(context?.runtime ? { runtime: context.runtime as RuntimeTaskAddress['runtime'] } : {}),
    ...(context?.threadId ? { threadId: context.threadId } : {}),
    ...(context?.workspacePath ? { workspacePath: context.workspacePath } : {}),
    ...(context?.workspaceKind ? { workspaceKind: context.workspaceKind } : {}),
    ...(context?.worktreeId ? { worktreeId: context.worktreeId } : {}),
    ...(binding.modelSelection
      ? {
          runtimeHandle: {
            ...address.runtimeHandle,
            modelSelection: binding.modelSelection,
          },
        }
      : {}),
  }
}

function TimelineReply({
  rootId,
  createdAt,
  replyLabel,
  active,
  onReply,
}: {
  rootId: string
  createdAt: string
  replyLabel: string
  active: boolean
  onReply: () => void
}) {
  return (
    <div className="task-detail-thread-actions">
      <time dateTime={createdAt} className="text-xs text-text-muted">
        {formatIssueTimestamp(createdAt)}
      </time>
      <button
        type="button"
        data-testid={`cloud-task-activity-reply-toggle-${rootId}`}
        aria-expanded={active}
        aria-controls="issue-reply-composer"
        onClick={onReply}
      >
        {replyLabel}
      </button>
    </div>
  )
}

function isVersionConflict(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false
  if ('status' in cause && cause.status === 409) return true
  if ('code' in cause && cause.code === 'version_conflict') return true
  return 'errorCode' in cause && cause.errorCode === 'version_conflict'
}

export function TaskActivityView({
  commentAssignment,
  client,
  project,
  task,
  currentUserId,
  onTaskRead,
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
  focusedCommentRequestKey = null,
  onStartHumanTaskFromReply,
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
  const projectLocation = project.project_store === 'local' ? 'local' : 'cloud'
  const projectDeliveryApi =
    projectLocation === 'local'
      ? (services.projectSpaceApis?.local ?? services.deliveryApi)
      : (services.projectSpaceApis?.cloud ?? services.deliveryApi)
  const activityHistory = useIssueActivityHistory(
    task,
    statusHistory,
    issueTimeline,
    projectDeliveryApi
  )
  const taskAiServices = useMemo(
    () => ({
      deliveryApi: projectDeliveryApi,
      chatStream: services.chatStream,
    }),
    [projectDeliveryApi, services.chatStream]
  )
  const prepareComment = useMemo(
    () =>
      createTaskCommentPreparer({
        local: projectLocation === 'local',
        importAttachments: projectDeliveryApi
          ? files => projectDeliveryApi.importLoopItemAttachments(task.id, files)
          : undefined,
        uploadLocalAttachmentToCloud: services.attachmentApi?.uploadLocalAttachmentToCloud,
        persistFailedText: t('workbench.task_activity_attachment_persist_failed'),
      }),
    [
      task.id,
      projectLocation,
      projectDeliveryApi,
      services.attachmentApi?.uploadLocalAttachmentToCloud,
      t,
    ]
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
  const threadMessages = useMemo(
    () => messages.filter(message => message.taskId === task.id),
    [messages, task]
  )
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
  // A reply on a thread with no execution to continue only lands as a comment.
  // When a manager assigned this member a human work item, the reply also opens
  // that work item's task composer.
  // Local spaces expose both the signed-in identity and the device identity.
  const humanUserIds =
    projectLocation === 'local'
      ? [currentUserId, chatCurrentUserId].filter((id): id is string | number => id != null)
      : (chatCurrentUserId ?? currentUserId)
  const currentHumanDispatch = humanDispatchAssignment(threadMessages, humanUserIds)
  function humanDispatchForCard(card: TaskReplyCard) {
    if (!currentHumanDispatch) return null
    const assignment = humanDispatchAssignment([card.root, ...card.replies], humanUserIds)
    return assignment?.humanAssignmentId === currentHumanDispatch.humanAssignmentId
      ? assignment
      : null
  }
  function cardReplyLabel(card: TaskReplyCard) {
    if (humanDispatchForCard(card)) return t('workbench.task_activity_reply_start_new_task')
    return t(
      [card.root, ...card.replies].some(message => message.sender.type === 'agent')
        ? 'workbench.task_activity_reply_action'
        : 'workbench.task_activity_reply_discussion'
    )
  }
  const replyHumanDispatch =
    replyTarget && onStartHumanTaskFromReply ? humanDispatchForCard(replyTarget) : null
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
  const [loadedActivity, setLoadedActivity] = useState<{
    client: ProjectChatClient
    projectId: string
    issueId: string
    version: number
  } | null>(null)
  const activityLoaded =
    !client ||
    (loadedActivity?.client === client &&
      loadedActivity.projectId === project.id &&
      loadedActivity.issueId === task.id &&
      loadedActivity.version === task.version)
  const [sending, setSending] = useState(false)
  const cancellation = useIssueExecutionCancellation(
    String(task.id),
    cancelRuntimeTask,
    t('workbench.task_activity_stop_failed')
  )
  const cancellingMessageId = cancellation.stoppingMessageId
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const executionBinding = useActivityExecutionBinding(messages, executionDetail?.messageId)
  const compact = rail || linear
  const readScope = useRef<object | null>(null)
  useLayoutEffect(() => {
    readScope.current = {}
    return () => {
      readScope.current = null
    }
  }, [currentUserId, project.id, projectDeliveryApi, task.id])
  const markActivityRead = useCallback(
    async (sequence: number) => {
      const scope = readScope.current
      if (!projectDeliveryApi || !scope) return
      try {
        const updated = await projectDeliveryApi.markLoopItemRead(task.id, sequence)
        if (readScope.current !== scope) {
          throw new DOMException('Activity read scope changed', 'AbortError')
        }
        setReadError(null)
        onTaskRead?.(updated)
      } catch (cause) {
        if (readScope.current === scope) {
          setReadError(cause instanceof Error ? cause.message : t('workbench.save_failed'))
        }
        throw cause
      }
    },
    [onTaskRead, projectDeliveryApi, t, task.id]
  )
  const { listRef, followCard, scrollTaskCommentsToBottom, revealCardBottom } =
    useIssueActivityScroll({
      messages: threadMessages,
      loading: loading || !activityLoaded,
      issueId: issueTimeline ? task.id : undefined,
      readSequence: task.activity_read_sequence ?? 0,
      unread: Boolean(task.is_unread),
      unreadRevision: task.is_unread ? (task.content_revision ?? task.version) : undefined,
      onReadSequence: issueTimeline && projectDeliveryApi ? markActivityRead : undefined,
      linear,
      compact,
      cardTestIdPrefix: 'cloud-task-activity-card-',
    })

  // Land once per notification, then leave scrolling under the reader's control.
  const flashedCommentId = useFocusedComment(
    listRef,
    threadMessages,
    focusedCommentId,
    focusedCommentRequestKey
  )

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
        setLoadedActivity({
          client,
          projectId: project.id,
          issueId: task.id,
          version: task.version,
        })
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
  }, [client, project.id, t, task.id, task.version])

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
  const commentCards = useMemo<IssueActivityThreadModel<ProjectChatMessage>[]>(
    () =>
      issueTimeline
        ? groupIssueTimelineThreads(threadMessages)
        : groupIssueActivityThreads(threadMessages),
    [issueTimeline, threadMessages]
  )
  const activityEntries = useMemo(
    () =>
      issueActivityTimeline({
        cards: commentCards,
        enabled: issueTimeline,
        createdAt: task.created_at,
        ...activityHistory,
      }),
    [activityHistory, commentCards, issueTimeline, task.created_at]
  )

  function cardSessionActive(card: TaskReplyCard) {
    if (onStartHumanTaskFromReply && humanDispatchForCard(card)) return false
    return sharedCardSessionActive(card, address => {
      const runtime = lifecycleSnapshot.tasks.get(getRuntimeTaskLifecycleKey(address))
      return runtime?.execution.known ? runtime.derived.isBusy : undefined
    })
  }
  const replyQueue = useTaskReplyQueue({
    store: taskReplyQueueStore,
    scope: `task-activity:${projectLocation}:${project.id}:${task.id}`,
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
    let persisted = false
    try {
      const prepared = await prepareComment(reply.content, reply.attachments ?? [])
      const dispatch = humanDispatchForCard(card)
      if (dispatch && onStartHumanTaskFromReply) {
        const message = await client.send({
          projectId: project.id,
          taskId: task.id,
          clientMessageId: reply.id,
          text: prepared.text,
          mentions: (reply.mentions ?? []).filter(mention => mention.type === 'user'),
          replyToMessageId: card.root.messageId,
          model: null,
        })
        persisted = true
        setMessages(current => mergeProjectChatMessages(current, [message]))
        void persistConversationAttachments(reply.attachments ?? [])
        await onStartHumanTaskFromReply({
          issueId: String(task.id),
          dispatch,
          replyText: reply.content,
        })
        return { ok: true, persisted: true }
      }
      const result = await dispatchTaskCardReply({
        client,
        services: taskAiServices,
        runtime: { createProjectRuntimeTask, sendRuntimePaneMessage },
        project,
        task,
        agent: assignedAgent,
        selfManagedExecution,
        card,
        sessionAddress: boundCardSessionAddress(card, taskBindings),
        reply: { ...reply, attachments: prepared.attachments },
        prepareComment: async () => prepared.text,
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
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : t('workbench.project_chat_send_failed')
      setError(error)
      return { ok: false, persisted, error }
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
    let persisted = false
    const attachments = attachmentSelection.attachments
    if (!client || !text || sending) return false
    if (!attachmentSelection.isAttachmentReadyToSend) {
      setError(t('workbench.task_activity_attachment_uploading'))
      return false
    }
    setSending(true)
    setError(null)
    try {
      const prepared = await prepareComment(text, attachments)
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
        text: prepared.text,
        mentions: activeMentions,
        replyToMessageId: null,
        model: client.executeTaskComment ? null : (selectedModel?.name ?? null),
        ...(projectLocation === 'local' && executionProject
          ? { localProjectId: executionProject.id }
          : {}),
      })
      followCard(message.messageId)
      persisted = true
      setMessages(current => mergeProjectChatMessages(current, [message]))
      setNewCommentDraft('')
      attachmentSelection.resetAttachments()
      scrollTaskCommentsToBottom()
      void persistConversationAttachments(attachments)
      if (client.executeTaskComment) {
        const incoming = await client.executeTaskComment({
          projectId: project.id,
          taskId: task.id,
          triggerMessageId: message.messageId,
          attachmentIds: prepared.attachments.map(file => file.id),
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
          attachments: prepared.attachments,
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
    return persisted
  }

  async function submitTimelineComment(
    text: string,
    mentions: ProjectChatMention[]
  ): Promise<boolean> {
    if (!replyTarget) {
      return sendNewComment(text, mentions)
    }
    if (!attachmentSelection.isAttachmentReadyToSend) {
      setError(t('workbench.task_activity_attachment_uploading'))
      return false
    }
    const result = await sendCardReply(replyTarget, text, mentions, attachmentSelection.attachments)
    if (!result.ok) {
      setError(result.error ?? t('workbench.project_chat_send_failed'))
      return false
    }
    setReplyTarget(null)
    setNewCommentDraft('')
    attachmentSelection.resetAttachments()
    return true
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
      <IssueChangeRequestBadges api={services.deviceApi} badges={task.badges ?? []} />
      <IssueActivityFeed
        mode={linear ? 'linear' : rail ? 'rail' : 'document'}
        testId={`cloud-task-activity-${task.id}`}
        listTestId="cloud-task-activity-list"
        listRef={listRef}
        translate={activityTranslate}
        count={issueTimeline ? activityEntries.length : threadMessages.length}
        loading={loading}
        error={cancellation.error ?? readError}
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
          issueTimeline && (linear || client?.executeTaskComment) ? (
            <div
              ref={replyComposerRef}
              {...(replyTarget
                ? {
                    id: 'issue-reply-composer',
                    'data-testid': 'issue-reply-composer',
                  }
                : {})}
            >
              {replyTarget ? (
                <div className="mx-3 border-b border-border/60 px-1 text-xs text-text-muted">
                  <div className="flex min-h-8 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {t(
                        replyHumanDispatch
                          ? 'workbench.task_activity_replying_to_human'
                          : 'workbench.task_activity_replying_to',
                        {
                          name: replyTarget.root.sender.name,
                        }
                      )}
                      {replyTarget.root.content ? ` · ${replyTarget.root.content}` : ''}
                    </span>
                    <button
                      type="button"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary"
                      data-testid="issue-reply-cancel"
                      aria-label={t('workbench.task_activity_cancel_reply')}
                      onClick={() => setReplyTarget(null)}
                    >
                      ×
                    </button>
                  </div>
                  {replyHumanDispatch ? (
                    <p
                      className="min-h-6 pb-1.5 leading-5"
                      data-testid="issue-reply-starts-task-hint"
                    >
                      {t('workbench.task_activity_reply_starts_task', {
                        title: replyHumanDispatch.taskTitle,
                      })}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <TaskCommentComposer
                assignment={!replyTarget ? commentAssignment : undefined}
                predictionAddress={
                  replyTarget && !replyHumanDispatch
                    ? boundCardSessionAddress(replyTarget, taskBindings)
                    : null
                }
                key={task.id}
                value={newCommentDraft}
                onChange={setNewCommentDraft}
                onSubmit={submitTimelineComment}
                disabled={!client}
                sending={sending}
                error={error ?? (!client ? t('workbench.project_chat_cloud_required') : null)}
                mentionCandidates={mentionCandidates}
                translate={activityTranslate}
                controls={commentProjectChat}
                projectWork={commentProjectWork}
                serverExecution={Boolean(client?.executeTaskComment)}
                placeholder={
                  replyTarget ? t('workbench.task_activity_inline_placeholder') : undefined
                }
              />
            </div>
          ) : (
            <>
              {linear || client?.executeTaskComment ? (
                <TaskCommentComposer
                  assignment={commentAssignment}
                  key={task.id}
                  value={newCommentDraft}
                  onChange={setNewCommentDraft}
                  onSubmit={sendNewComment}
                  disabled={!client}
                  sending={sending}
                  error={error ?? (!client ? t('workbench.project_chat_cloud_required') : null)}
                  mentionCandidates={mentionCandidates}
                  translate={activityTranslate}
                  controls={commentProjectChat}
                  projectWork={commentProjectWork}
                  serverExecution={Boolean(client?.executeTaskComment)}
                />
              ) : (
                <div className="task-detail-comment-chat-input">
                  <ChatInput
                    predictionAddress={null}
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
          )
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
                    className="task-detail-timeline-system-event"
                  >
                    <span className="task-detail-timeline-marker" aria-hidden="true" />
                    <div className="task-detail-timeline-system-content text-xs text-text-primary">
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
                    className="task-detail-timeline-system-event"
                  >
                    <span className="task-detail-timeline-marker" aria-hidden="true" />
                    <div className="task-detail-timeline-system-content">
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
              if (activity.kind === 'assignment') {
                return (
                  <IssueAssignmentEvent
                    key={`assignment-${activity.index}`}
                    entry={activity.entry}
                    index={activity.index}
                    projectMembers={projectMembers}
                  />
                )
              }
              const card = activity.card
              const displayReplies = card.displayReplies ?? card.replies
              const rootId = card.root.messageId
              const role = issueActivityRole(card.root)
              if (
                issueTimeline &&
                role === 'manager' &&
                card.root.metadata.activity_type !== 'manager_status_comment'
              ) {
                const address = messageRuntimeAddress(card.root)
                const binding = address
                  ? taskBindings.find(
                      item => item.device_id === address.deviceId && item.task_id === address.taskId
                    )
                  : undefined
                return (
                  <div key={rootId} data-testid={`cloud-task-activity-card-${rootId}`}>
                    <div data-activity-sequence={card.root.sequenceNumber}>
                      <IssueManagerEvent
                        message={card.root}
                        task={task}
                        onOpenExecution={
                          binding && onOpenTask ? () => onOpenTask(binding) : undefined
                        }
                      />
                    </div>
                    <div data-testid={`cloud-task-activity-replies-${rootId}`}>
                      {card.replies.map(reply => renderActivityMessage(reply))}
                    </div>
                    {humanDispatchForCard(card) && onStartHumanTaskFromReply ? (
                      <TimelineReply
                        rootId={rootId}
                        createdAt={issueThreadActivityTimestamp(card)}
                        replyLabel={cardReplyLabel(card)}
                        active={replyTarget?.root.messageId === rootId}
                        onReply={() => setReplyTarget(card)}
                      />
                    ) : null}
                  </div>
                )
              }
              const executions = [card.root, ...card.replies].filter(
                message => message.sender.type === 'agent'
              )
              return (
                <IssueActivityThread
                  key={rootId}
                  variant={issueTimeline ? 'timeline' : 'card'}
                  cardAttributes={{
                    'data-testid': `cloud-task-activity-card-${rootId}`,
                  }}
                  message={renderActivityMessage(card.root, false, issueTimeline)}
                  replies={
                    displayReplies.length
                      ? displayReplies.map(reply => renderActivityMessage(reply))
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
                          createdAt={issueThreadActivityTimestamp(card)}
                          replyLabel={cardReplyLabel(card)}
                          active={replyTarget?.root.messageId === rootId}
                          onReply={() => setReplyTarget(card)}
                        />
                      ) : (
                        <CardCommentComposer
                          predictionAddress={boundCardSessionAddress(card, taskBindings)}
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
            projectLocation === 'local'
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
