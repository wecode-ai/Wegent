import {
  ArrowDownUp,
  Bot,
  Check,
  ExternalLink,
  Hash,
  LoaderCircle,
  MessageSquareText,
  Square,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { createProjectChatAgentApi } from '@/api/projectChatAgents'
import type { Attachment, RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { ChatInput, type ProjectChatControls } from '@/components/chat/ChatInput'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import { DESKTOP_MESSAGE_LIST_CLASS } from '@/components/layout/desktopChatLayout'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchModels } from '@/features/workbench/useWorkbenchModels'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import {
  buildRobotRoleDescription,
  mergeProjectChatMessages,
  startTaskAiRun,
} from './taskAiExecution'
import { RuntimeTaskExecutionOverlay } from './RuntimeTaskExecutionOverlay'
import { CardCommentComposer, type CardCommentSendResult } from './CardCommentComposer'

interface TaskActivityViewProps {
  client?: ProjectChatClient
  project: CloudProject
  task: CloudLoopItem
  currentUserId?: string | number
  onTaskUpdated?: (task: CloudLoopItem) => void
  projectChatAgentApi?: ReturnType<typeof createProjectChatAgentApi>
  // When true, the chat client owns the AI execution lifecycle (local project
  // spaces enqueue a robot run inside send), so the shared runtime-task start
  // flow must not run again.
  selfManagedExecution?: boolean
  // rail mode: fill a fixed-height side column with an internally scrolling
  // message list and a composer pinned to the bottom
  rail?: boolean
  linear?: boolean
}

export function TaskActivityView({
  client,
  project,
  task,
  currentUserId,
  onTaskUpdated,
  projectChatAgentApi,
  selfManagedExecution = false,
  rail = false,
  linear = false,
}: TaskActivityViewProps) {
  const { t } = useTranslation('common')
  const { services, createProjectRuntimeTask, cancelRuntimeTask, sendRuntimePaneMessage } =
    useWorkbenchPaneContext()
  // Local project spaces keep their board, comments and runs in the local
  // executor; every delivery/approval call must route to the project's space
  // API instead of always hitting the cloud backend.
  const projectLocation = (project as { location?: 'local' | 'cloud' }).location
  const projectDeliveryApi =
    projectLocation === 'local'
      ? (services.projectSpaceApis?.local ?? services.deliveryApi)
      : (services.projectSpaceApis?.cloud ?? services.deliveryApi)
  const [executionDetail, setExecutionDetail] = useState<{
    address: RuntimeTaskAddress
    senderName: string
    runId: string | null
    modelName: string | null
    runStatus: string | null
  } | null>(null)
  const modelSelection = useWorkbenchModels({
    api: services.modelApi,
    locked: false,
    scopeKey: `task-activity-${project.id}`,
    persistSelection: false,
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
      selectedModel,
      selectedModelOptions,
      setSelectedModel,
      setSelectedModelOption,
    ]
  )
  const [messages, setMessages] = useState<ProjectChatMessage[]>([])
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [chatCurrentUserId, setChatCurrentUserId] = useState<string | null>(null)
  const [cardAiErrors, setCardAiErrors] = useState<Record<string, string>>({})
  const [newCommentDraft, setNewCommentDraft] = useState('')
  const [loading, setLoading] = useState(Boolean(client))
  const [sending, setSending] = useState(false)
  const [cancellingMessageId, setCancellingMessageId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const followCardRef = useRef<string | null>(null)
  const refreshedRunIds = useRef(new Set<string>())
  const compact = rail || linear

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
  const scrollTaskCommentsToTop = useCallback((behavior: ScrollBehavior = 'auto') => {
    const scroller = findTaskCommentScrollContainer(listRef.current)
    if (scroller) {
      if (typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top: 0, behavior })
      } else {
        scroller.scrollTop = 0
      }
    }
  }, [])

  // Card replies grow inside their own card; keep the card's bottom visible
  // (where the new reply and the streaming AI response appear) instead of
  // jumping to the end of the whole comment list.
  const revealCardBottom = useCallback((cardId: string, behavior: ScrollBehavior = 'auto') => {
    const card = listRef.current?.querySelector<HTMLElement>(
      `[data-testid="cloud-task-activity-card-${cardId}"]`
    )
    const scroller = findTaskCommentScrollContainer(listRef.current)
    if (!card || !scroller) return
    const scrollerRect = scroller.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    if (cardRect.bottom > scrollerRect.bottom) {
      scroller.scrollTo({
        top: scroller.scrollTop + cardRect.bottom - scrollerRect.bottom + 12,
        behavior,
      })
    }
  }, [])

  useEffect(() => {
    const scroller = findTaskCommentScrollContainer(listRef.current)
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
  }, [compact, loading, messages.length])

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
      if (task.ai_state?.status === 'running') {
        console.info('[Wework] Task activity waiting for terminal AI message', {
          taskId: task.id,
          taskStatus: task.status,
          aiStatus: task.ai_state.status,
          aiMessageId: task.ai_state.project_chat_message_id,
          runtimeDeviceId: task.ai_state.runtime_device_id,
          runtimeTaskId: task.ai_state.runtime_task_id,
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
  }, [messages, onTaskUpdated, projectDeliveryApi, t, task.id, task.status])

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
  const activeUserId = currentUserId ?? chatCurrentUserId
  const isBotCreator = assignedAgent
    ? String(assignedAgent.createdByUserId ?? '') === String(activeUserId ?? '')
    : false
  const canApproveCurrentRun = task.can_approve === true || isBotCreator
  const awaitingApproval = task.execution_state === 'pending_approval'
  const aiTerminalFailure = ['failed', 'interrupted', 'stalled', 'cancelled', 'canceled'].includes(
    task.ai_state?.status ?? ''
  )
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
    return latest?.runtimeAddress
      ? {
          runtimeDeviceId: latest.runtimeAddress.deviceId,
          runtimeTaskId: latest.runtimeAddress.taskId,
        }
      : null
  }

  function cardSessionActive(card: { root: ProjectChatMessage; replies: ProjectChatMessage[] }) {
    const session = cardSessionAddress(card)
    if (!session) return false
    return [card.root, ...card.replies].some(
      message =>
        message.sender.type === 'agent' &&
        message.status === 'streaming' &&
        message.runtimeAddress?.deviceId === session.runtimeDeviceId &&
        message.runtimeAddress?.taskId === session.runtimeTaskId
    )
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

  function focusContinueComment() {
    document.querySelector<HTMLElement>('[data-testid="cloud-task-activity-composer"]')?.focus()
  }

  async function rerunTaskAi() {
    if (!client || !assignedAgent || sending) return
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
        services,
        runtime: { createProjectRuntimeTask, sendRuntimePaneMessage },
        project,
        task,
        agent: assignedAgent,
        prompt: buildRobotRoleDescription(assignedAgent),
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
    if (cardSessionActive(card)) {
      return { ok: false, error: t('workbench.runtime_task_running_message') }
    }
    setSending(true)
    setError(null)
    try {
      const activeMentions = assignedAgent
        ? [{ type: 'agent' as const, id: assignedAgent.id, label: assignedAgent.name }]
        : []
      const message = await client.send({
        projectId: project.id,
        taskId: task.id,
        clientMessageId: crypto.randomUUID(),
        text,
        mentions: activeMentions,
        // Card composer replies are always one-level replies under the parent
        // comment.
        replyToMessageId: rootId,
        model: selectedModel?.name ?? null,
      })
      // Card replies must never trigger the list-bottom follow: switch to
      // following this card synchronously so the message-change effect cannot
      // scroll the whole comment list to its end during the AI start.
      followCardRef.current = rootId
      setMessages(current => mergeProjectChatMessages(current, [message]))
      setCardAiErrors(current => ({ ...current, [rootId]: '' }))
      if (assignedAgent && !selfManagedExecution) {
        // The comment is already posted; keep the input cleared and let the
        // AI start settle in the background, surfacing failures in the card.
        void startTaskAiRun({
          client,
          services,
          runtime: { createProjectRuntimeTask, sendRuntimePaneMessage },
          project,
          task,
          agent: assignedAgent,
          prompt: text,
          trigger: message,
          messages,
          replyTo: cardSessionAddress(card),
          threadRootId: rootId,
          attachments,
          models: availableModels,
          selectedModel,
          selectedModelOptions,
          onError: message => setCardAiErrors(current => ({ ...current, [rootId]: message })),
          onMessages: incoming =>
            setMessages(current => mergeProjectChatMessages(current, incoming)),
          onTaskUpdated,
          startFailedText: t('workbench.project_chat_agent_start_failed'),
        })
      }
      revealCardBottom(rootId)
      return { ok: true }
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : t('workbench.project_chat_send_failed'),
      }
    } finally {
      setSending(false)
    }
  }

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
      const activeMentions = assignedAgent
        ? [{ type: 'agent' as const, id: assignedAgent.id, label: assignedAgent.name }]
        : []
      const message = await client.send({
        projectId: project.id,
        taskId: task.id,
        clientMessageId: crypto.randomUUID(),
        text,
        mentions: activeMentions,
        replyToMessageId: null,
        model: selectedModel?.name ?? null,
      })
      followCardRef.current = message.messageId
      setMessages(current => mergeProjectChatMessages(current, [message]))
      setNewCommentDraft('')
      attachmentSelection.resetAttachments()
      scrollTaskCommentsToTop()
      if (assignedAgent && !selfManagedExecution) {
        await startTaskAiRun({
          client,
          services,
          runtime: { createProjectRuntimeTask, sendRuntimePaneMessage },
          project,
          task,
          agent: assignedAgent,
          prompt: text,
          trigger: message,
          messages,
          replyTo: null,
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
              {compact ? '评论' : t('workbench.task_activity_title')}
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
          {assignedAgent ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-700">
              <Bot className="h-3.5 w-3.5" />
              {assignedAgent.name}
            </span>
          ) : null}
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
          {awaitingApproval && !canApproveCurrentRun ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700">
              {assignedAgent?.createdByUserName
                ? t('workbench.task_activity_awaiting_approval_with_creator', {
                    name: assignedAgent.createdByUserName,
                  })
                : t('workbench.task_activity_awaiting_approval')}
            </span>
          ) : null}
          {task.execution_state === 'cancelled' ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-700">
              {t('workbench.task_activity_cancelled')}
            </span>
          ) : null}
          {task.execution_note ? (
            <span
              data-testid={`cloud-task-activity-execution-note-${task.id}`}
              className="inline-flex max-w-56 items-center gap-1.5 truncate rounded-full bg-muted px-2.5 py-1 text-xs text-text-secondary"
              title={task.execution_note}
            >
              {task.execution_note}
            </span>
          ) : null}
          {assignedAgent &&
          (task.execution_state === 'queued' ||
            task.execution_state === 'claimed' ||
            task.execution_state === 'assigned') &&
          task.status !== 'in_review' ? (
            <button
              type="button"
              data-testid={`cloud-task-activity-run-now-${task.id}`}
              disabled={!client || sending}
              onClick={() => void rerunTaskAi()}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition hover:bg-muted hover:text-text-primary disabled:opacity-50"
            >
              {t('workbench.task_activity_run_now')}
            </button>
          ) : null}
          {task.status === 'in_review' || task.ai_state?.status === 'completed' ? (
            <div
              data-testid={`cloud-task-activity-review-actions-${task.id}`}
              className="flex items-center gap-1.5"
            >
              <button
                type="button"
                data-testid={`cloud-task-activity-continue-${task.id}`}
                onClick={focusContinueComment}
                className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition hover:bg-muted hover:text-text-primary"
              >
                {t('workbench.task_activity_continue')}
              </button>
              {assignedAgent ? (
                <button
                  type="button"
                  data-testid={`cloud-task-activity-rerun-${task.id}`}
                  disabled={!client || sending}
                  onClick={() => void rerunTaskAi()}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition hover:bg-muted hover:text-text-primary disabled:opacity-50"
                >
                  {t('workbench.task_activity_rerun')}
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
              disabled={!client || sending}
              onClick={() => void rerunTaskAi()}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition hover:bg-muted hover:text-text-primary disabled:opacity-50"
            >
              {t('workbench.task_activity_rerun')}
            </button>
          ) : null}
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
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
              {t('workbench.project_chat_loading')}
            </div>
          ) : threadMessages.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center text-center">
              <MessageSquareText className="h-8 w-8 text-text-muted" />
              <p className="mt-3 text-sm font-medium text-text-primary">
                {t('workbench.task_activity_empty')}
              </p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-text-muted">
                {assignedAgent
                  ? t('workbench.task_activity_empty_with_ai', { name: assignedAgent.name })
                  : t('workbench.task_activity_empty_without_ai')}
              </p>
            </div>
          ) : linear ? (
            <div className="flex flex-col">
              {commentCards.map(card => {
                const rootId = card.root.messageId
                return (
                  <article
                    key={rootId}
                    data-testid={`cloud-task-activity-card-${rootId}`}
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
                      onOpenExecution={
                        card.root.runtimeAddress
                          ? () =>
                              setExecutionDetail({
                                address: card.root.runtimeAddress!,
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
                        card.root.runtimeAddress ? () => void stopRuntimeTask(card.root) : undefined
                      }
                      stopping={cancellingMessageId === card.root.messageId}
                    />
                    {card.replies.length > 0 ? (
                      <div
                        className="task-detail-comment-replies"
                        data-testid={`cloud-task-activity-replies-${rootId}`}
                      >
                        {card.replies.map(reply => (
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
                            onOpenExecution={
                              reply.runtimeAddress
                                ? () =>
                                    setExecutionDetail({
                                      address: reply.runtimeAddress!,
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
                              reply.runtimeAddress ? () => void stopRuntimeTask(reply) : undefined
                            }
                            stopping={cancellingMessageId === reply.messageId}
                          />
                        ))}
                      </div>
                    ) : null}
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
              {threadMessages.map(message => (
                <ChatMessage
                  key={message.messageId}
                  message={message}
                  mine={
                    message.sender.type === 'user' &&
                    String(message.sender.id) === String(chatCurrentUserId ?? currentUserId ?? '')
                  }
                  compact={compact}
                  taskAiState={task.ai_state}
                  onOpenExecution={
                    message.runtimeAddress
                      ? () =>
                          setExecutionDetail({
                            address: message.runtimeAddress!,
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
                    message.runtimeAddress ? () => void stopRuntimeTask(message) : undefined
                  }
                  stopping={cancellingMessageId === message.messageId}
                />
              ))}
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
              placeholder={
                assignedAgent
                  ? t('workbench.task_activity_ai_placeholder', { name: assignedAgent.name })
                  : t('workbench.task_activity_placeholder')
              }
              variant="desktop"
              projectChat={commentProjectChat}
              showProjectWorkBar={false}
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

function resolveMessageRunStatus(
  taskAiState: CloudLoopItem['ai_state'] | undefined,
  message: ProjectChatMessage
): string {
  return taskAiState?.project_chat_message_id === message.messageId && taskAiState.status
    ? taskAiState.status
    : message.status
}

function ChatMessage({
  message,
  mine,
  compact = false,
  plain = false,
  taskAiState,
  onOpenExecution,
  onStopExecution,
  stopping = false,
}: {
  message: ProjectChatMessage
  mine: boolean
  compact?: boolean
  /** Render inside a parent comment card without the outer card border. */
  plain?: boolean
  taskAiState?: CloudLoopItem['ai_state']
  onOpenExecution?: () => void
  onStopExecution?: () => void
  stopping?: boolean
}) {
  const { t } = useTranslation('common')
  const text = message.content
  const isAgent = message.sender.type === 'agent'
  const isSubagent = message.metadata.kind === 'task_ai_subagent'
  const runId = typeof message.metadata.run_id === 'string' ? message.metadata.run_id : null
  const modelName = typeof message.metadata.model === 'string' ? message.metadata.model : null
  const runStatus = resolveMessageRunStatus(taskAiState, message)
  const mentionedAgents = Array.isArray(message.metadata.mentions)
    ? message.metadata.mentions.filter(
        mention =>
          typeof mention === 'object' &&
          mention !== null &&
          (mention as Record<string, unknown>).type === 'agent'
      )
    : []
  const body = (
    <>
      {text ? (
        <div
          className={cn('min-w-0 text-text-primary', compact ? 'text-sm leading-6' : 'text-chat')}
        >
          {isAgent ? (
            <AssistantMarkdown content={text} isStreaming={message.status === 'streaming'} />
          ) : (
            <span className="whitespace-pre-wrap break-words">{text}</span>
          )}
        </div>
      ) : message.type === 'agent_status' ? (
        <span className="text-sm text-text-muted">
          {t('workbench.project_chat_processing_ellipsis')}
        </span>
      ) : null}
      {isAgent && !compact && message.status === 'completed' ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-text-muted">
          <Check className="h-3 w-3" /> {t('workbench.project_chat_completed')}
        </span>
      ) : null}
      {!isAgent && mentionedAgents.length > 0 ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-violet-600">
          <Bot className="h-3 w-3" /> {t('workbench.project_chat_ai_received')}
        </span>
      ) : null}
      {isAgent && !compact && message.status === 'streaming' ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-text-muted">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          {t('workbench.project_chat_processing')}
        </span>
      ) : null}
      {isAgent && !compact && onOpenExecution ? (
        <button
          type="button"
          data-testid={`cloud-task-activity-open-execution-${message.messageId}`}
          onClick={onOpenExecution}
          className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t('workbench.task_activity_view_execution')}
        </button>
      ) : null}
    </>
  )
  const avatar = (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        compact
          ? isAgent
            ? 'bg-violet-600 text-background'
            : 'bg-muted text-text-secondary'
          : isAgent
            ? 'bg-violet-500/10 text-violet-600'
            : 'bg-muted text-text-secondary'
      )}
    >
      {isAgent ? <Bot className="h-4 w-4" /> : message.sender.name.slice(0, 1).toUpperCase()}
    </span>
  )

  if (compact) {
    if (isAgent && !plain) {
      return (
        <article
          data-testid={`cloud-task-activity-message-${message.messageId}`}
          data-side="left"
          className="task-detail-ai-run-card"
        >
          <div className="task-detail-ai-run-header">
            {avatar}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-text-primary">
                  {message.sender.name}
                </span>
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                  {isSubagent
                    ? t('workbench.task_activity_subagent_execution')
                    : t('workbench.task_activity_ai_execution')}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <span>{message.createdAt.slice(5, 16).replace('T', ' ')}</span>
                {runId ? <span>Run {runId.slice(0, 8)}</span> : null}
                {modelName ? <span>{modelName}</span> : null}
              </div>
            </div>
            <ExecutionStatusBadge
              status={runStatus}
              onOpenExecution={onOpenExecution}
              onStopExecution={onStopExecution}
              stopping={stopping}
            />
          </div>
          <div className="task-detail-ai-run-body">{body}</div>
        </article>
      )
    }

    return (
      <article
        data-testid={`cloud-task-activity-message-${message.messageId}`}
        data-side={mine ? 'right' : 'left'}
        className="flex gap-2.5 py-3"
      >
        {avatar}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[7px]">
            <span className="truncate text-sm font-semibold text-text-primary">
              {message.sender.name}
            </span>
            <span className="shrink-0 text-xs text-text-muted">
              {isAgent
                ? isSubagent
                  ? t('workbench.task_activity_subagent_execution')
                  : t('workbench.task_activity_ai_execution')
                : t('workbench.task_activity_comment')}
            </span>
            <span className="ml-auto shrink-0 text-xs text-text-muted">
              {message.createdAt.slice(5, 16).replace('T', ' ')}
            </span>
          </div>
          <div className="mt-1 text-sm leading-6">{body}</div>
          {isAgent ? (
            <ExecutionStatusBadge
              status={runStatus}
              onOpenExecution={onOpenExecution}
              onStopExecution={onStopExecution}
              stopping={stopping}
            />
          ) : null}
        </div>
      </article>
    )
  }

  return (
    <article
      data-testid={`cloud-task-activity-message-${message.messageId}`}
      data-side={mine ? 'right' : 'left'}
      className="overflow-hidden rounded-xl border border-border bg-background shadow-sm"
    >
      <header className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3">
        {avatar}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary">
            {message.sender.name}
          </span>
          <span className="block text-xs text-text-muted">
            {isAgent
              ? t('workbench.task_activity_ai_execution')
              : t('workbench.task_activity_comment')}
            {isAgent && modelName ? ` · ${modelName}` : ''}
          </span>
        </span>
      </header>
      <div className="px-4 py-4">{body}</div>
    </article>
  )
}

function ExecutionStatusBadge({
  status,
  onOpenExecution,
  onStopExecution,
  stopping = false,
}: {
  status: string
  onOpenExecution?: () => void
  onStopExecution?: () => void
  stopping?: boolean
}) {
  const { t } = useTranslation('common')
  const terminal = [
    'completed',
    'failed',
    'interrupted',
    'stalled',
    'cancelled',
    'canceled',
  ].includes(status)
  const statusContent =
    status === 'completed' ? (
      <>
        <Check className="h-3 w-3" />
        {t('workbench.project_chat_completed')}
      </>
    ) : ['failed', 'interrupted', 'stalled', 'cancelled', 'canceled'].includes(status) ? (
      <>
        <ExternalLink className="h-3.5 w-3.5" />
        {t('workbench.task_activity_failed')}
      </>
    ) : (
      <>
        <LoaderCircle className="h-3 w-3 animate-spin" />
        {t('workbench.project_chat_processing')}
      </>
    )

  return (
    <span
      className={cn(
        'task-detail-execution-pill',
        status === 'failed' && 'is-failed',
        !onOpenExecution && 'is-static'
      )}
    >
      <button
        type="button"
        disabled={!onOpenExecution}
        onClick={onOpenExecution}
        className="task-detail-execution-main"
      >
        <span className="task-detail-execution-status">{statusContent}</span>
        <span className="task-detail-execution-hover">
          <ExternalLink className="h-3.5 w-3.5" />
          {t('workbench.task_activity_view_execution')}
        </span>
      </button>
      <button
        type="button"
        disabled={terminal || !onStopExecution || stopping}
        title={t('workbench.task_activity_stop_execution')}
        aria-label={t('workbench.task_activity_stop_execution')}
        className="task-detail-execution-stop"
        onClick={event => {
          event.stopPropagation()
          onStopExecution?.()
        }}
      >
        {stopping ? (
          <LoaderCircle className="h-3 w-3 animate-spin" />
        ) : (
          <Square className="h-3 w-3" />
        )}
      </button>
    </span>
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
