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
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { ChatInput, type ProjectChatControls } from '@/components/chat/ChatInput'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import {
  DESKTOP_CHAT_CONTENT_WIDTH_CLASS,
  DESKTOP_MESSAGE_LIST_CLASS,
} from '@/components/layout/desktopChatLayout'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchModels } from '@/features/workbench/useWorkbenchModels'
import {
  buildTaskAiInitialPrompt,
  mergeProjectChatMessages,
  startTaskAiRun,
} from './taskAiExecution'
import { RuntimeTaskExecutionOverlay } from './RuntimeTaskExecutionOverlay'

interface TaskActivityViewProps {
  client?: ProjectChatClient
  project: CloudProject
  task: CloudLoopItem
  currentUserId?: string | number
  onTaskUpdated?: (task: CloudLoopItem) => void
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
  rail = false,
  linear = false,
}: TaskActivityViewProps) {
  const { t } = useTranslation('common')
  const { services, createProjectRuntimeTask, cancelRuntimeTask, sendRuntimePaneMessage } =
    useWorkbenchPaneContext()
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
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
      isOptionsLocked: false,
      setSelectedModel,
      setSelectedModelOption,
      toggleSkill: () => {},
      handleFileSelect: async () => {},
      removeAttachment: async () => {},
      listLocalSkills: async () => [],
      listLocalApps: async () => [],
    }),
    [
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
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(Boolean(client))
  const [sending, setSending] = useState(false)
  const [cancellingMessageId, setCancellingMessageId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const followBottomRef = useRef(true)
  const refreshedRunIds = useRef(new Set<string>())
  const compact = rail || linear

  useEffect(() => {
    if (!services.projectChatAgentApi) return
    void services.projectChatAgentApi
      .list(project.id)
      .then(setAgents)
      .catch(cause => {
        setError(
          cause instanceof Error ? cause.message : t('workbench.project_chat_agents_load_failed')
        )
      })
  }, [project.id, services.projectChatAgentApi, t])

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

  // Follow the newest comment the same way the task conversation page does:
  // stay pinned to the bottom while the user is there (including streaming
  // AI chunks), stop following once the user scrolls up, and jump back to the
  // bottom on send or on an initial load.
  const scrollTaskCommentsToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const scroller = findTaskCommentScrollContainer(listRef.current)
    if (scroller) {
      if (typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior })
      } else {
        scroller.scrollTop = scroller.scrollHeight
      }
    } else {
      endRef.current?.scrollIntoView?.({ block: 'end' })
    }
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (followBottomRef.current) scrollTaskCommentsToBottom()
    })
    return () => cancelAnimationFrame(frame)
  }, [compact, loading, messages, scrollTaskCommentsToBottom])

  useEffect(() => {
    const scroller = findTaskCommentScrollContainer(listRef.current)
    if (!scroller) return
    const updateFollowState = () => {
      const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
      followBottomRef.current = distance <= 48
    }
    scroller.addEventListener('scroll', updateFollowState, { passive: true })
    return () => scroller.removeEventListener('scroll', updateFollowState)
  }, [compact, loading, messages.length])

  useEffect(() => {
    if (
      !services.deliveryApi ||
      typeof services.deliveryApi.getLoopItem !== 'function' ||
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
    void services.deliveryApi
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
  }, [messages, onTaskUpdated, services.deliveryApi, t, task.id, task.status])

  const threadMessages = useMemo(
    () => messages.filter(message => message.taskId === task.id),
    [messages, task]
  )
  const assignedAgent = useMemo(
    () => agents.find(agent => agent.id === task.assignee_agent_id && agent.status === 'active'),
    [agents, task.assignee_agent_id]
  )
  const activeUserId = currentUserId ?? chatCurrentUserId
  const isBotCreator = assignedAgent
    ? String(assignedAgent.createdByUserId ?? '') === String(activeUserId ?? '')
    : false
  const awaitingApproval = task.execution_state === 'pending_approval'
  const aiTerminalFailure = ['failed', 'interrupted', 'stalled', 'cancelled', 'canceled'].includes(
    task.ai_state?.status ?? ''
  )

  async function sendMessage() {
    const text = draft.trim()
    if (!(await sendText(text))) return
    setDraft('')
  }

  async function acceptTask() {
    if (!services.deliveryApi) return
    setError(null)
    try {
      const updated = await services.deliveryApi.updateLoopItem(task.id, {
        version: task.version,
        status: 'completed',
      })
      onTaskUpdated?.(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.task_activity_accept_failed'))
    }
  }

  async function approveTaskRun() {
    if (!services.deliveryApi || !project) return
    setError(null)
    try {
      const updated = await services.deliveryApi.approveLoopItemRun(
        project.id,
        task.id,
        task.version
      )
      onTaskUpdated?.(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.task_activity_approve_failed'))
    }
  }

  async function rejectTaskRun() {
    if (!services.deliveryApi || !project) return
    const reason = window.prompt(t('workbench.task_activity_reject_reason_prompt')) ?? undefined
    if (reason === undefined) return
    setError(null)
    try {
      const updated = await services.deliveryApi.rejectLoopItemRun(
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
        prompt: buildTaskAiInitialPrompt(task),
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

  async function sendText(text: string): Promise<boolean> {
    if (!client || !text || sending) return false
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
        model: selectedModel?.name ?? null,
      })
      followBottomRef.current = true
      setMessages(current => mergeProjectChatMessages(current, [message]))
      if (assignedAgent) {
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
          {awaitingApproval && isBotCreator ? (
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
          {awaitingApproval && !isBotCreator ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700">
              {t('workbench.task_activity_awaiting_approval')}
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
          (task.execution_state === 'queued' || task.execution_state === 'assigned') &&
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
          {task.status === 'in_review' ? (
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
              {services.deliveryApi ? (
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
          ) : (
            <div
              className={
                rail
                  ? 'flex flex-col divide-y divide-border/70 pb-4'
                  : linear
                    ? 'flex flex-col divide-y divide-border/70'
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
              <div ref={endRef} />
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
          {compact ? (
            <div className="task-detail-comment-chat-input">
              <ChatInput
                value={draft}
                disabled={!client}
                onChange={setDraft}
                onSubmit={() => sendMessage()}
                submitDisabled={!draft.trim() || sending}
                error={error ?? (!client ? t('workbench.project_chat_cloud_required') : null)}
                placeholder={
                  assignedAgent
                    ? t('workbench.task_activity_ai_placeholder', { name: assignedAgent.name })
                    : t('workbench.task_activity_placeholder')
                }
                variant="desktop"
                projectChat={commentProjectChat}
                showProjectWorkBar={false}
                composerMode="default"
                composerInputTestId="cloud-task-activity-composer"
              />
            </div>
          ) : (
            <div className={cn(DESKTOP_CHAT_CONTENT_WIDTH_CLASS, 'relative')}>
              <ChatInput
                value={draft}
                disabled={!client}
                onChange={setDraft}
                onSubmit={() => sendMessage()}
                submitDisabled={!draft.trim() || sending}
                error={error ?? (!client ? t('workbench.project_chat_cloud_required') : null)}
                placeholder={
                  assignedAgent
                    ? t('workbench.task_activity_ai_placeholder', { name: assignedAgent.name })
                    : t('workbench.task_activity_placeholder')
                }
                variant="desktop"
                projectChat={commentProjectChat}
                showProjectWorkBar={false}
                composerMode="default"
                composerInputTestId="cloud-task-activity-composer"
              />
            </div>
          )}
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
  taskAiState,
  onOpenExecution,
  onStopExecution,
  stopping = false,
}: {
  message: ProjectChatMessage
  mine: boolean
  compact?: boolean
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
    if (isAgent) {
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
                ? t('workbench.task_activity_ai_execution')
                : t('workbench.task_activity_comment')}
            </span>
            <span className="ml-auto shrink-0 text-xs text-text-muted">
              {message.createdAt.slice(5, 16).replace('T', ' ')}
            </span>
          </div>
          <div className="mt-1 text-sm leading-6">{body}</div>
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
