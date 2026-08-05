import {
  ArrowDownUp,
  Bot,
  Check,
  ExternalLink,
  Hash,
  LoaderCircle,
  MessageCircle,
  MessageSquareText,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { ChatInput } from '@/components/chat/ChatInput'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import {
  DESKTOP_CHAT_CONTENT_WIDTH_CLASS,
  DESKTOP_MESSAGE_LIST_CLASS,
} from '@/components/layout/desktopChatLayout'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { projectSpaceChatRuntimeContext } from './projectProviderConfig'

interface TaskActivityViewProps {
  client?: ProjectChatClient
  project: CloudProject
  task: CloudLoopItem
  currentUserId?: string | number
  onTaskUpdated?: (task: CloudLoopItem) => void
  // rail mode: fill a fixed-height side column with an internally scrolling
  // message list and a composer pinned to the bottom
  rail?: boolean
}

export function TaskActivityView({
  client,
  project,
  task,
  currentUserId,
  onTaskUpdated,
  rail = false,
}: TaskActivityViewProps) {
  const { t } = useTranslation('common')
  const { services, createProjectRuntimeTask, openRuntimeTask, sendRuntimePaneMessage } =
    useWorkbenchPaneContext()
  const [messages, setMessages] = useState<ProjectChatMessage[]>([])
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [chatCurrentUserId, setChatCurrentUserId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(Boolean(client))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const reviewedResponseIds = useRef(new Set<string>())
  const initialRunStarted = useRef(false)
  const runStatusStarted = useRef(false)

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
          if (active) setMessages(current => mergeMessages(current, [message]))
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
        setMessages(current => mergeMessages(current, subscription.snapshot.messages))
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

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages])

  useEffect(() => {
    if (!task || !services.deliveryApi || task.status === 'completed') return
    const completedResponse = messages.find(
      message =>
        message.taskId === task.id &&
        message.sender.type === 'agent' &&
        message.status === 'completed' &&
        !reviewedResponseIds.current.has(message.messageId)
    )
    if (!completedResponse || task.status === 'in_review') return
    reviewedResponseIds.current.add(completedResponse.messageId)
    void services.deliveryApi
      .updateLoopItem(task.id, { version: task.version, status: 'in_review' })
      .then(updated => onTaskUpdated?.(updated))
      .catch(cause => setError(cause instanceof Error ? cause.message : '更新待确认状态失败'))
  }, [messages, onTaskUpdated, services.deliveryApi, task])

  const threadMessages = useMemo(
    () => messages.filter(message => message.taskId === task.id),
    [messages, task]
  )
  const assignedAgent = useMemo(
    () => agents.find(agent => agent.id === task.assignee_agent_id && agent.status === 'active'),
    [agents, task.assignee_agent_id]
  )

  async function sendMessage() {
    const text = draft.trim()
    if (!(await sendText(text))) return
    setDraft('')
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
      })
      setMessages(current => mergeMessages(current, [message]))
      if (assignedAgent) {
        runStatusStarted.current = false
        await runAssignedAgent(assignedAgent, text, message)
      }
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.project_chat_send_failed'))
    } finally {
      setSending(false)
    }
    return false
  }

  useEffect(() => {
    if (
      loading ||
      !task ||
      !assignedAgent ||
      threadMessages.length > 0 ||
      initialRunStarted.current
    ) {
      return
    }
    initialRunStarted.current = true
    const taskPrompt = [
      `请开始执行任务 ${task.id}：${task.title}`,
      task.description.trim(),
      '完成后请总结实际改动、验证结果、未完成事项和风险，提交给人类验收。',
    ]
      .filter(Boolean)
      .join('\n\n')
    void sendText(taskPrompt)
  }, [assignedAgent, loading, task, threadMessages.length])

  async function runAssignedAgent(
    agent: ProjectChatAgent,
    prompt: string,
    trigger: ProjectChatMessage
  ) {
    if (!client) return
    const previousRuntime = [...messages]
      .reverse()
      .find(
        message =>
          message.taskId === task.id &&
          message.agentId === agent.id &&
          message.runtimeAddress?.deviceId &&
          message.runtimeAddress?.taskId
      )?.runtimeAddress
    if (previousRuntime) {
      let response: ProjectChatMessage | null = await client.startAgentResponse({
        projectId: project.id,
        taskId: task.id,
        triggerMessageId: trigger.messageId,
        agentId: agent.id,
        runtimeDeviceId: previousRuntime.deviceId,
        runtimeTaskId: previousRuntime.taskId,
      })
      setMessages(current => mergeMessages(current, response ? [response] : []))
      if (
        task &&
        services.deliveryApi &&
        task.status !== 'in_progress' &&
        !runStatusStarted.current
      ) {
        runStatusStarted.current = true
        const updated = await services.deliveryApi.updateLoopItem(task.id, {
          version: task.version,
          status: 'in_progress',
        })
        onTaskUpdated?.(updated)
      }
      const sent = await sendRuntimePaneMessage(
        {
          address: previousRuntime,
          message: prompt,
          ephemeral: true,
          additionalContext: {
            projectChatHistory: {
              kind: 'untrusted',
              value: formatProjectChatHistory(messages, trigger),
            },
          },
        },
        { onError: setError }
      )
      if (!sent && response) {
        response = await client.failAgentResponse({
          projectId: project.id,
          taskId: task.id,
          messageId: response.messageId,
          error: t('workbench.project_chat_agent_start_failed'),
        })
        setMessages(current => mergeMessages(current, response ? [response] : []))
      }
      return
    }
    let response: ProjectChatMessage | null = null
    const address = await createProjectRuntimeTask(prompt, {
      project: null,
      modelId: agent.model,
      collaborationMode: 'default',
      cloudProjectId: String(project.id),
      hiddenFromSidebar: true,
      additionalContext: {
        ...projectSpaceChatRuntimeContext(project),
        projectChatHistory: {
          kind: 'untrusted',
          value: formatProjectChatHistory(messages, trigger),
        },
        projectChat: {
          kind: 'application',
          value: [
            `This run was started by task activity ${trigger.messageId}.`,
            `Reply to task cloud://projects/${project.id}/todos/${task.id}.`,
            'Your final response is a reviewable task comment. Report actual changes, verification, unfinished work, and risks.',
          ].join('\n'),
        },
        projectChatAgent: {
          kind: 'application',
          value: agent.systemPrompt
            ? `You are ${agent.name}, the AI owner of this project task.\n${agent.systemPrompt}`
            : `You are ${agent.name}, the AI owner of this project task.`,
        },
      },
      onError: setError,
      onRuntimeTaskOptimisticOpen: async address => {
        if (task) await services.deliveryApi?.bindTask(task.id, address, task.title)
        if (
          task &&
          services.deliveryApi &&
          task.status !== 'in_progress' &&
          !runStatusStarted.current
        ) {
          runStatusStarted.current = true
          const updated = await services.deliveryApi.updateLoopItem(task.id, {
            version: task.version,
            status: 'in_progress',
          })
          onTaskUpdated?.(updated)
        }
        response = await client.startAgentResponse({
          projectId: project.id,
          taskId: task.id,
          triggerMessageId: trigger.messageId,
          agentId: agent.id,
          runtimeDeviceId: address.deviceId,
          runtimeTaskId: address.taskId,
        })
        setMessages(current => mergeMessages(current, response ? [response] : []))
      },
    })
    if (!address) {
      if (response) {
        try {
          const failed = await client.failAgentResponse({
            projectId: project.id,
            taskId: task.id,
            messageId: response.messageId,
            error: t('workbench.project_chat_agent_start_failed'),
          })
          if (failed) setMessages(current => mergeMessages(current, [failed]))
        } catch (cause) {
          console.warn('[Wework] Failed to close rejected project chat AI run', cause)
        }
      }
      setError(t('workbench.project_chat_agent_start_failed'))
    }
  }

  return (
    <section
      data-testid={`cloud-task-activity-${task.id}`}
      className={
        rail ? 'flex h-full min-h-0 flex-col max-md:block' : 'mt-8 border-t border-border pt-6'
      }
    >
      <header
        className={cn(
          'flex min-h-8 items-center gap-3',
          rail && 'shrink-0 bg-muted/40 px-[18px] pb-[10px] pt-[14px]'
        )}
      >
        <span
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-text-secondary',
            rail && 'hidden'
          )}
        >
          <Hash className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span
            className={cn('block font-semibold text-text-primary', rail ? 'text-base' : 'text-sm')}
          >
            {rail ? '评论' : t('workbench.task_activity_title')}
          </span>
        </span>
        {rail && threadMessages.length > 0 ? (
          <span className="text-sm text-text-muted">
            {t('workbench.task_activity_count', { count: threadMessages.length })}
          </span>
        ) : null}
        <span className="flex-1" />
        {rail ? (
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
        {task.status === 'in_review' && services.deliveryApi ? (
          <button
            type="button"
            data-testid={`cloud-task-activity-accept-${task.id}`}
            onClick={() => {
              void services.deliveryApi
                ?.updateLoopItem(task.id, { version: task.version, status: 'completed' })
                .then(updated => onTaskUpdated?.(updated))
                .catch(cause => setError(cause instanceof Error ? cause.message : '验收失败'))
            }}
            className="rounded-lg bg-text-primary px-3 py-1.5 text-xs font-medium text-background"
          >
            {t('workbench.task_activity_accept')}
          </button>
        ) : null}
      </header>

      <div
        className={rail ? 'min-h-0 flex-1 overflow-y-auto px-[18px] pb-4 pt-0.5' : 'min-h-48 py-3'}
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
                rail={rail}
                onOpenExecution={
                  message.runtimeAddress
                    ? () => void openRuntimeTask(message.runtimeAddress!)
                    : undefined
                }
              />
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <footer
        className={rail ? 'shrink-0 border-t border-border bg-background px-[18px] py-3' : 'pt-2'}
      >
        {rail ? (
          <>
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-transparent bg-muted px-3.5 py-2 focus-within:border-blue-500/40 focus-within:bg-background">
                <input
                  data-testid="cloud-task-activity-composer"
                  value={draft}
                  disabled={!client}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void sendMessage()
                    }
                  }}
                  placeholder="说点什么..."
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-text-muted disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  disabled={!draft.trim() || sending || !client}
                  onClick={() => void sendMessage()}
                  className="rounded-full px-2.5 py-1 text-sm font-medium text-text-muted transition enabled:hover:bg-blue-600 enabled:hover:text-background disabled:opacity-60"
                >
                  发送
                </button>
              </div>
            </div>
            {(error || !client) && (
              <p className="mt-2 px-1 text-xs text-destructive">
                {error ?? t('workbench.project_chat_cloud_required')}
              </p>
            )}
          </>
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
              showProjectWorkBar={false}
              composerMode="message-only"
              composerInputTestId="cloud-task-activity-composer"
            />
          </div>
        )}
      </footer>
    </section>
  )
}

function formatProjectChatHistory(
  current: ProjectChatMessage[],
  trigger: ProjectChatMessage
): string {
  const lines = mergeMessages(current, [trigger])
    .filter(message => message.status === 'completed' && message.content.trim())
    .slice(-40)
    .map(message => {
      const role =
        message.sender.type === 'agent' ? `AI ${message.sender.name}` : message.sender.name
      return `[${role}] ${message.content.trim()}`
    })
  return [
    '<project_chat_history order="oldest-first">',
    lines.join('\n').slice(-20_000),
    '</project_chat_history>',
    'Use this shared project-chat history to resolve references to earlier messages. Do not claim that only the current message is visible.',
  ].join('\n')
}

function ChatMessage({
  message,
  mine,
  rail = false,
  onOpenExecution,
}: {
  message: ProjectChatMessage
  mine: boolean
  rail?: boolean
  onOpenExecution?: () => void
}) {
  const { t } = useTranslation('common')
  const text = message.content
  const isAgent = message.sender.type === 'agent'
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
        <div className={cn('min-w-0 text-text-primary', rail ? 'text-sm leading-6' : 'text-chat')}>
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
      {isAgent && message.status === 'completed' ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-text-muted">
          <Check className="h-3 w-3" /> {t('workbench.project_chat_completed')}
        </span>
      ) : null}
      {!isAgent && mentionedAgents.length > 0 ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-violet-600">
          <Bot className="h-3 w-3" /> {t('workbench.project_chat_ai_received')}
        </span>
      ) : null}
      {isAgent && message.status === 'streaming' ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-text-muted">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          {t('workbench.project_chat_processing')}
        </span>
      ) : null}
      {isAgent && onOpenExecution ? (
        <button
          type="button"
          data-testid={`cloud-task-activity-open-execution-${message.messageId}`}
          onClick={onOpenExecution}
          className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          查看执行细节
        </button>
      ) : null}
    </>
  )
  const avatar = (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        rail
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

  // rail mode: flat Xiaohongshu-style comment row instead of a bordered card
  if (rail) {
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
          <div className="mt-[7px] flex items-center gap-4 text-xs text-text-muted">
            <button
              type="button"
              className="flex items-center gap-1 rounded px-1 py-0.5 transition hover:bg-muted hover:text-text-primary"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              回复
            </button>
          </div>
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
          </span>
        </span>
      </header>
      <div className="px-4 py-4">{body}</div>
    </article>
  )
}

function mergeMessages(
  current: ProjectChatMessage[],
  incoming: ProjectChatMessage[]
): ProjectChatMessage[] {
  const byId = new Map(current.map(message => [message.messageId, message]))
  incoming.forEach(message => byId.set(message.messageId, message))
  return [...byId.values()].sort((left, right) => left.sequenceNumber - right.sequenceNumber)
}

function appendAgentChunk(
  current: ProjectChatMessage[],
  chunk: ProjectChatMessage
): ProjectChatMessage[] {
  const existing = current.find(message => message.messageId === chunk.messageId)
  if (!existing) return mergeMessages(current, [chunk])
  return mergeMessages(current, [
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
