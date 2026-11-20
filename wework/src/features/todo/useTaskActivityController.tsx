import { type IssueReplyContextKind } from './issueReplyCopy'

import { issueAssignmentRevision, sameIssueAssignment } from './issueAssignmentReceiptScope'
import { issueActivityTimeline } from './issueActivityTimeline'
import { collapsedIssueActivity } from './collapsedIssueActivity'
import { useIssueActivityHistory } from './useIssueActivityHistory'
import { isPublicStandInMessage } from './issueActivityRole'
import { useActivityExecutionBinding } from './useActivityExecutionStatus'
import { useNotificationEntity } from '@/features/notifications/NotificationEntityContext'
import { notificationCommentFocus } from '@/features/notifications/notificationCommentFocus'
import { useIssueActivityScroll } from '@wegent/collaboration/issue-detail/useIssueActivityScroll'
import { useTaskActivityState } from './useTaskActivityState'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import { useFocusedComment } from './useFocusedComment'
import { useIssueCommentDraft } from './useIssueCommentDraft'
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
  groupIssueActivityThreads,
  groupIssueTimelineThreads,
  createCollaborationTranslator,
  humanDispatchAssignment,
  type IssueActivityThreadModel,
} from '@wegent/collaboration'

import { canApproveIssueExecution } from '@wegent/collaboration/issue-detail/activityApproval'
import { issueExecutionApprovalCreator } from './issueExecutionApproval'
import { LOCAL_USER } from '@/api/local/localSession'

import { createTaskCommentPreparer } from './prepareTaskComment'
import { useCallback, useContext, useMemo, useRef, useState } from 'react'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import type { ProjectChatMention, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import { projectChatAgentWorkspaceBinding } from '@/api/projectChatAgents'

import type {
  Attachment,
  ModelSelectionConfig,
  RuntimeTaskAddress,
  UnifiedModel,
} from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

import { findWorkbenchDevice } from '@/lib/workbench-device'
import { type ProjectChatControls, type ProjectWorkControls } from '@/components/chat/ChatInput'

import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchModels } from '@/features/workbench/useWorkbenchModels'
import { useScopedComposerAttachments } from '@/features/workbench/useScopedComposerAttachments'
import {
  getRuntimeTaskLifecycleKey,
  useRuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'

import {
  selectActivityRerunModel,
  refreshTaskAfterComment,
  startTaskAiRun,
} from './taskAiExecution'

import { type CardCommentSendResult } from './CardCommentComposer'

import {
  useNotificationCommentReply,
  useNotificationCommentDispatch,
} from '@/features/notifications/useNotificationCommentReply'
import { useIssueExecutionCancellation } from '@wegent/collaboration/issue-detail/useIssueExecutionCancellation'
import { type ExecutionTaskSummary } from './TaskActivityMessage'

import { boundCardSessionAddress } from './taskActivityHelpers'
import {
  EMPTY_STATUS_HISTORY,
  type TaskActivityViewProps,
  type ActivityExecutionDetail,
  type TaskCardQueuedReply,
} from './taskActivityTypes'
export function useTaskActivityController({
  commentActions,
  assignmentReceipts,
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
  onOpenRuntimeTask,
  onRefreshExecutionArtifacts,
  members = [],
  agents = [],
  focusedCommentId = null,
  focusedCommentRequestKey = null,
  onStartHumanTaskFromReply,
}: TaskActivityViewProps) {
  const { t, i18n } = useTranslation('common')
  const cloud = useContext(CloudConnectionContext)
  const activityTranslate = createCollaborationTranslator(
    i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  )
  const mentionCandidates = useIssueMentionCandidates(members, agents, activityTranslate)
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot()
  const {
    services,
    state,
    projectChat,
    workspaceTabId,
    createProjectRuntimeTask,
    cancelRuntimeTask,
    sendRuntimePaneMessage,
  } = useWorkbenchPaneContext()
  const projectLocation = project.project_store === 'local' ? 'local' : 'cloud'
  const commentDraftScope = JSON.stringify([
    'issue-comment',
    workspaceTabId,
    cloud?.apiBaseUrl ?? '',
    cloud?.user?.id ?? null,
    state.user?.id ?? currentUserId ?? LOCAL_USER.id,
    currentUserId ?? null,
    projectLocation,
    project.id,
    task.id,
  ])
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
  const notificationEntity = useNotificationEntity()
  const activityInput = useMemo(
    () => ({
      task,
      lifecycleTrace: { issueTimeline, linear },
      bindings: taskBindings,
      notification: notificationEntity,
      devices: state.devices,
      store: project.project_store,
      onTaskRead,
      onTaskUpdated,
      onRefreshExecutionArtifacts,
      t,
    }),
    [
      task,
      issueTimeline,
      linear,
      taskBindings,
      notificationEntity,
      state.devices,
      project.project_store,
      onTaskRead,
      onTaskUpdated,
      onRefreshExecutionArtifacts,
      t,
    ]
  )
  const { source: activity, snapshot: activitySnapshot } = useTaskActivityState(
    JSON.stringify([
      commentDraftScope,
      currentUserId,
      project.access_role,
      project.workspace_access_role,
    ]),
    client,
    projectDeliveryApi,
    projectChatAgentApi ?? services.projectChatAgentApi,
    project.id,
    task.id,
    activityInput
  )
  const { messages, projectChatAgents, chatCurrentUserId, loading, sending, error, readError } =
    activitySnapshot
  const reportError = activity.reportError
  const updateActivityTask = activity.taskUpdated
  const assignedAgent = useMemo(
    () =>
      projectChatAgents.find(
        agent => agent.id === task.assignee_agent_id && agent.status === 'active'
      ),
    [projectChatAgents, task.assignee_agent_id]
  )
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
  const attachmentSelection = useScopedComposerAttachments(projectChat, commentDraftScope)
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
      dismissAttachmentError: attachmentSelection.dismissAttachmentError,
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
  const threadMessages = useMemo(
    () => messages.filter(message => message.taskId === task.id),
    [messages, task]
  )
  const commentCards = useMemo<IssueActivityThreadModel<ProjectChatMessage>[]>(
    () =>
      issueTimeline
        ? groupIssueTimelineThreads(threadMessages)
        : groupIssueActivityThreads(threadMessages),
    [issueTimeline, threadMessages]
  )
  const {
    text: newCommentDraft,
    setText: setNewCommentDraft,
    replyTarget: selectedReplyTarget,
    setReplyTarget,
    replyFocusRequest,
    beginReply,
  } = useIssueCommentDraft(commentDraftScope)
  const replyTarget = selectedReplyTarget
    ? (commentCards.find(card => card.root.messageId === selectedReplyTarget.root.messageId) ??
      selectedReplyTarget)
    : null
  const replyComposerRef = useRef<HTMLDivElement>(null)
  useFocusRequest(replyComposerRef, replyFocusRequest ?? undefined, {
    enabled: Boolean(
      replyFocusRequest &&
      replyFocusRequest.scope === commentDraftScope &&
      replyFocusRequest.rootId === selectedReplyTarget?.root.messageId
    ),
    selector: '[contenteditable="true"], textarea',
  })
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
  function cardHasExecution(card: TaskReplyCard) {
    return [card.root, ...card.replies].some(
      message =>
        message.sender.type === 'agent' && message.metadata.execution_dispatch !== 'comment_only'
    )
  }
  function cardReplyLabel(card: TaskReplyCard) {
    if (humanDispatchForCard(card)) return t('workbench.task_activity_reply_start_new_task')
    return t(
      cardHasExecution(card)
        ? 'workbench.task_activity_reply_action'
        : 'workbench.task_activity_reply_discussion'
    )
  }
  const replyHumanDispatch =
    replyTarget && onStartHumanTaskFromReply ? humanDispatchForCard(replyTarget) : null
  const replySessionAddress =
    replyTarget && !replyHumanDispatch ? boundCardSessionAddress(replyTarget, taskBindings) : null
  const replyContextKind: IssueReplyContextKind = replyHumanDispatch
    ? 'human'
    : replyTarget && isPublicStandInMessage(replyTarget.root)
      ? 'stand-in'
      : replySessionAddress
        ? 'execution'
        : 'discussion'
  const assignedAgentProjectId = useMemo(() => {
    if (!assignedAgent) return null
    const binding = projectChatAgentWorkspaceBinding(assignedAgent)
    if (binding.status !== 'ready' || binding.type !== 'backend_project') return null
    if (!localProjects.some(project => project.id === binding.projectId)) return null
    return binding.projectId
  }, [assignedAgent, localProjects])
  const [commentProjectChoice, setCommentProjectChoice] = useState<number | '' | null>(null)
  const selectedCommentProjectId =
    commentProjectChoice ?? taskPageProject?.id ?? assignedAgentProjectId ?? ''
  const activityLoaded = !client || activitySnapshot.loadedVersion === task.version
  const cancellation = useIssueExecutionCancellation(
    String(task.id),
    cancelRuntimeTask,
    t('workbench.task_activity_stop_failed')
  )
  const cancellingMessageId = cancellation.stoppingMessageId
  const [expandedActivityScope, setExpandedActivityScope] = useState<string | null>(null)
  const activityScope = `${project.project_store}:${project.id}:${task.id}`
  const executionBinding = useActivityExecutionBinding(messages, executionDetail?.messageId)
  const compact = rail || linear
  const markActivityRead = activity.markRead
  const { listRef, followCard, scrollTaskCommentsToBottom, revealCardBottom } =
    useIssueActivityScroll({
      messages: threadMessages,
      loading: loading || !activityLoaded,
      issueId: issueTimeline ? task.id : undefined,
      readSequence: task.activity_read_sequence ?? 0,
      unread: Boolean(task.is_unread),
      // Inbox notifications can arrive after the Issue content was already read.
      // A visible visit must still acknowledge them through the shared read API.
      unreadRevision: task.content_revision ?? task.version,
      readRequestKey: focusedCommentRequestKey,
      visibilityRevision: expandedActivityScope,
      onReadSequence: issueTimeline && projectDeliveryApi ? markActivityRead : undefined,
      linear,
      compact,
      cardTestIdPrefix: 'cloud-task-activity-card-',
    })
  const ownsNotification =
    notificationEntity?.projectId === project.id &&
    notificationEntity?.issueId === task.id &&
    notificationEntity?.store === project.project_store
  const notificationCommentId = ownsNotification
    ? notificationCommentFocus(
        threadMessages,
        notificationEntity?.address,
        notificationEntity?.sourceMessageIds,
        state.devices
      )
    : undefined
  const flashedCommentId = useFocusedComment(
    listRef,
    threadMessages,
    notificationCommentId !== undefined ? notificationCommentId : focusedCommentId,
    ownsNotification ? (notificationEntity?.id ?? null) : focusedCommentRequestKey,
    !loading && Boolean(activityLoaded) && !activityHistory.loading
  )
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
  const approvalUserId = projectLocation === 'local' ? LOCAL_USER.id : activeUserId
  const canApproveCurrentRun = canApproveIssueExecution(
    task.can_approve,
    issueExecutionApprovalCreator(task, threadMessages, projectChatAgents),
    approvalUserId
  )
  const notificationReply = useNotificationCommentReply({
    projectId: project.id,
    issueId: task.id,
    store: project.project_store,
    cards: commentCards,
    draftScope: commentDraftScope,
  })
  const notificationComposer = notificationReply?.composing ? notificationReply : null
  const coordinateCommentDispatch = useNotificationCommentDispatch({
    projectId: project.id,
    issueId: task.id,
    store: project.project_store,
  })
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
  const latestAssignment = activityEntries.findLast(activity => activity.kind === 'assignment')
  const visibleActivity = useMemo(
    () =>
      collapsedIssueActivity(
        activityEntries,
        expandedActivityScope === activityScope ||
          Boolean(notificationCommentId ?? focusedCommentId) ||
          Boolean(replyTarget),
        activity =>
          activity.kind === 'comment'
            ? [activity.card.root, ...activity.card.replies].map(message => message.sequenceNumber)
            : []
      ),
    [
      activityEntries,
      activityScope,
      expandedActivityScope,
      notificationCommentId,
      focusedCommentId,
      replyTarget,
    ]
  )
  const currentReceipts = sameIssueAssignment(
    assignmentReceipts,
    task.id,
    task.version,
    task.assignee_user_id,
    issueAssignmentRevision(task)
  )
    ? assignmentReceipts
    : null
  function cardSessionActive(card: TaskReplyCard) {
    if (onStartHumanTaskFromReply && humanDispatchForCard(card)) return false
    return sharedCardSessionActive(card, address => {
      const runtime = lifecycleSnapshot.tasks.get(getRuntimeTaskLifecycleKey(address))
      return runtime?.execution.known ? runtime.derived.isBusy : undefined
    })
  }
  const replyQueue = useTaskReplyQueue({
    store: taskReplyQueueStore,
    scope: JSON.stringify([
      'task-activity',
      cloud?.apiBaseUrl ?? '',
      cloud?.user?.id ?? null,
      state.user?.id ?? currentUserId ?? LOCAL_USER.id,
      currentUserId ?? null,
      projectLocation,
      project.id,
      task.id,
    ]),
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
    return issueTaskSummaryForMessage(
      message,
      taskBindings,
      task.title,
      onOpenTask,
      issueTimeline && project.project_store === 'backend' ? onOpenRuntimeTask : undefined
    )
  }
  function deviceNameForMessage(message: ProjectChatMessage): string | null {
    const deviceId = message.runtimeAddress?.deviceId
    if (!deviceId) return null
    const mappedName = deviceNamesById?.[deviceId]?.trim()
    if (mappedName) return mappedName
    return findWorkbenchDevice(state.devices, deviceId)?.name.trim() || null
  }
  const acceptTask = activity.acceptTask
  const approveTaskRun = activity.approveTaskRun
  async function rejectTaskRun() {
    const reason = window.prompt(t('workbench.task_activity_reject_reason_prompt')) ?? undefined
    if (reason !== undefined) await activity.rejectTaskRun(reason.trim() || undefined)
  }

  async function stopRuntimeTask(message: ProjectChatMessage) {
    if (message.runtimeAddress) await cancellation.stop(message.messageId, message.runtimeAddress)
  }
  async function rerunTaskAi() {
    const isCurrent = activity.captureScope()
    if (!client || !assignedAgent || sending) return
    const completeSend = activity.beginSend()
    reportError(null)
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
        onError: reportError,
        onMessages: incoming => activity.receiveMessages(incoming),
        onTaskUpdated: updated => {
          if (isCurrent()) updateActivityTask(updated)
        },
        startFailedText: t('workbench.project_chat_agent_start_failed'),
      })
    } catch (cause) {
      reportError(
        cause instanceof Error ? cause.message : t('workbench.project_chat_agent_start_failed')
      )
    } finally {
      completeSend()
    }
  }
  async function persistConversationAttachments(attachments: Attachment[]) {
    if (projectLocation !== 'local' || !projectDeliveryApi || attachments.length === 0) return
    try {
      await projectDeliveryApi.importLoopItemAttachments(task.id, attachments)
    } catch (cause) {
      reportError(
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
    return coordinateCommentDispatch(card.root.messageId, reply, humanRequestId =>
      sendCardReplyNow(card, reply, humanRequestId)
    )
  }
  async function sendCardReplyNow(
    card: TaskReplyCard,
    reply: TaskCardQueuedReply,
    humanRequestId?: string
  ): Promise<TaskCardDispatchResult> {
    const isCurrent = activity.captureScope()
    if (!client)
      return { ok: false, persisted: false, error: t('workbench.project_chat_send_failed') }
    const completeSend = activity.beginSend()
    let persisted = false
    try {
      const prepared = await prepareComment(reply.content, reply.attachments ?? [])
      if (!isCurrent()) return { ok: false, persisted: false }
      const dispatch = humanDispatchForCard(card)
      if (dispatch && onStartHumanTaskFromReply && !humanRequestId) {
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
        if (!isCurrent()) return { ok: true, persisted: true }
        activity.receiveMessages([message])
        void persistConversationAttachments(reply.attachments ?? [])
        await onStartHumanTaskFromReply({
          issueId: String(task.id),
          dispatch,
          replyText: reply.content,
        })
        return { ok: true, persisted: true }
      }
      const result = await dispatchTaskCardReply({
        humanRequestId,
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
          if (!isCurrent()) return
          followCard(card.root.messageId)
          void persistConversationAttachments(reply.attachments ?? [])
        },
        onMessages: incoming => activity.receiveMessages(incoming),
        onError: error => {
          if (isCurrent()) replyQueue.setError(card.root.messageId, error)
        },
        onTaskUpdated: updated => {
          if (isCurrent()) updateActivityTask(updated)
        },
        onBindingChange: publishProjectSpaceTaskBindingChanged,
        startFailedText: t('workbench.project_chat_agent_start_failed'),
        sendFailedText: t('workbench.project_chat_send_failed'),
      })
      if (isCurrent() && result.persisted) revealCardBottom(card.root.messageId)
      return result
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : t('workbench.project_chat_send_failed')
      reportError(error)
      return { ok: false, persisted, error }
    } finally {
      completeSend()
    }
  }
  async function sendCardReply(
    card: TaskReplyCard,
    text: string,
    mentions: ProjectChatMention[],
    attachments: Attachment[],
    interactionId?: string
  ): Promise<CardCommentSendResult> {
    if (!client || !text) return { ok: false, error: t('workbench.project_chat_send_failed') }
    return replyQueue.enqueue(card.root.messageId, text, attachments, mentions, interactionId)
  }
  async function sendNewComment(
    text: string,
    mentions: ProjectChatMention[],
    submission?: { commentOnly?: boolean }
  ): Promise<boolean> {
    const isCurrent = activity.captureScope()
    let persisted = false
    const attachments = attachmentSelection.attachments
    if (!client || !text || sending) return false
    if (!attachmentSelection.isAttachmentReadyToSend) {
      reportError(t('workbench.task_activity_attachment_uploading'))
      return false
    }
    const completeSend = activity.beginSend()
    reportError(null)
    try {
      const prepared = await prepareComment(text, attachments)
      if (!isCurrent()) return false
      const executionProject = effectiveCommentProject
      const explicitMentions = commentAgentMentions(text, agents)
      const activeMentions: ProjectChatMention[] = [
        ...(submission?.commentOnly
          ? []
          : explicitMentions.length || projectLocation !== 'local'
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
      persisted = true
      if (!isCurrent()) return true
      followCard(message.messageId)
      activity.receiveMessages([message])
      setNewCommentDraft('')
      attachmentSelection.resetAttachments()
      scrollTaskCommentsToBottom()
      void persistConversationAttachments(attachments)
      if (!submission?.commentOnly && client.executeTaskComment) {
        const incoming = await client.executeTaskComment({
          projectId: project.id,
          taskId: task.id,
          triggerMessageId: message.messageId,
          attachmentIds: prepared.attachments.map(file => file.id),
        })
        activity.receiveMessages(incoming)
      } else if (!submission?.commentOnly && assignedAgent && !selfManagedExecution) {
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
          onError: reportError,
          onMessages: incoming => activity.receiveMessages(incoming),
          onTaskUpdated: updated => {
            if (isCurrent()) updateActivityTask(updated)
          },
          startFailedText: t('workbench.project_chat_agent_start_failed'),
        })
      }
      return true
    } catch (cause) {
      reportError(cause instanceof Error ? cause.message : t('workbench.project_chat_send_failed'))
    } finally {
      if (persisted && isCurrent())
        await refreshTaskAfterComment({
          projectId: project.id,
          taskId: task.id,
          getTask: projectDeliveryApi?.getLoopItem,
          onTaskUpdated: updated => {
            if (isCurrent()) updateActivityTask(updated)
          },
        })
      completeSend()
    }
    return persisted
  }
  async function submitTimelineComment(
    text: string,
    mentions: ProjectChatMention[],
    submission?: { commentOnly?: boolean }
  ): Promise<boolean> {
    const isCurrent = activity.captureScope()
    if (!replyTarget) {
      return sendNewComment(text, mentions, submission)
    }
    if (!attachmentSelection.isAttachmentReadyToSend) {
      reportError(t('workbench.task_activity_attachment_uploading'))
      return false
    }
    const result = await sendCardReply(
      replyTarget,
      text,
      mentions,
      attachmentSelection.attachments,
      notificationComposer?.id
    )
    if (!result.ok) {
      reportError(result.error ?? t('workbench.project_chat_send_failed'))
      return false
    }
    if (!isCurrent()) return result.ok
    setReplyTarget(null)
    setNewCommentDraft('')
    attachmentSelection.resetAttachments()
    return true
  }
  return {
    acceptTask,
    activeUserId,
    activity,
    activityEntries,
    activityScope,
    activityTranslate,
    approveTaskRun,
    assignedAgent,
    beginReply,
    canApproveCurrentRun,
    cancellation,
    cancellingMessageId,
    cardReplyLabel,
    chatCurrentUserId,
    client,
    commentActions,
    commentAssignment,
    commentProjectChat,
    commentProjectWork,
    compact,
    currentReceipts,
    currentUserId,
    deviceNameForMessage,
    error,
    executionBinding,
    executionDetail,
    flashedCommentId,
    humanDispatchForCard,
    issueTimeline,
    latestAssignment,
    linear,
    listRef,
    loading,
    localProjects,
    members,
    mentionCandidates,
    messageRuntimeAddress,
    messages,
    newCommentDraft,
    notificationComposer,
    onOpenRuntimeTask,
    onOpenTask,
    onStartHumanTaskFromReply,
    project,
    projectChat,
    projectDeliveryApi,
    projectLocation,
    projectMembers,
    rail,
    readError,
    rejectTaskRun,
    replyComposerRef,
    replyContextKind,
    replyHumanDispatch,
    replyQueue,
    replySessionAddress,
    replyTarget,
    rerunTaskAi,
    sendCardReply,
    sendNewComment,
    sending,
    services,
    setExecutionDetail,
    setExpandedActivityScope,
    setNewCommentDraft,
    setReplyTarget,
    stopRuntimeTask,
    submitTimelineComment,
    t,
    task,
    taskBindings,
    taskSummaryForMessage,
    threadMessages,
    visibleActivity,
  }
}
