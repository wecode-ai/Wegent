import { Bot, Check, CornerDownRight, Hash, LoaderCircle, Plus, Send, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject, CloudProjectMember } from '@/api/deliveries'
import type { ProjectChatMention } from '@/api/backend/projectChatSocket'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { projectSpaceChatRuntimeContext } from './projectProviderConfig'

interface ProjectGroupChatViewProps {
  client?: ProjectChatClient
  project: CloudProject
  task?: CloudLoopItem
  currentUserId?: string | number
  members?: CloudProjectMember[]
  onManageAgents?: () => void
  onClose?: () => void
}

export function ProjectGroupChatView({
  client,
  project,
  task,
  currentUserId,
  members = [],
  onManageAgents,
  onClose,
}: ProjectGroupChatViewProps) {
  const { t } = useTranslation('common')
  const { services, createProjectRuntimeTask } = useWorkbenchPaneContext()
  const [messages, setMessages] = useState<ProjectChatMessage[]>([])
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [chatCurrentUserId, setChatCurrentUserId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mentions, setMentions] = useState<ProjectChatMention[]>([])
  const [loading, setLoading] = useState(Boolean(client))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

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
        task?.id,
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
  }, [client, project.id, t, task?.id])

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages])

  const threadMessages = useMemo(
    () => (task ? messages.filter(message => message.taskId === task.id) : messages),
    [messages, task]
  )
  const mentionQuery = mentionQueryFromDraft(draft)
  const mentionCandidates = useMemo(() => {
    const query = mentionQuery?.toLocaleLowerCase() ?? ''
    return [
      ...agents
        .filter(agent => agent.status === 'active')
        .map(agent => ({
          type: 'agent' as const,
          id: agent.id,
          label: agent.name,
        })),
      ...members.map(member => ({
        type: 'user' as const,
        id: String(member.user_id),
        label: member.user_name,
      })),
    ].filter(candidate => candidate.label.toLocaleLowerCase().includes(query))
  }, [agents, members, mentionQuery])

  async function sendMessage() {
    const text = draft.trim()
    if (!client || !text || sending) return
    setSending(true)
    setError(null)
    try {
      const activeMentions = mentions.filter(mention => text.includes(`@${mention.label}`))
      const message = await client.send({
        projectId: project.id,
        taskId: task?.id,
        clientMessageId: crypto.randomUUID(),
        text,
        mentions: activeMentions,
      })
      setMessages(current => mergeMessages(current, [message]))
      setDraft('')
      setMentions([])
      await Promise.all(
        activeMentions
          .filter(mention => mention.type === 'agent')
          .map(mention => runMentionedAgent(mention, text, message))
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.project_chat_send_failed'))
    } finally {
      setSending(false)
    }
  }

  async function runMentionedAgent(
    mention: ProjectChatMention,
    prompt: string,
    trigger: ProjectChatMessage
  ) {
    if (!client) return
    const agent = agents.find(item => item.id === mention.id)
    if (!agent) {
      setError(t('workbench.project_chat_agent_unavailable'))
      return
    }
    let response: ProjectChatMessage | null = null
    const address = await createProjectRuntimeTask(prompt, {
      project: null,
      modelId: agent.model,
      collaborationMode: 'default',
      cloudProjectId: String(project.id),
      additionalContext: {
        ...projectSpaceChatRuntimeContext(project),
        projectChatHistory: {
          kind: 'untrusted',
          value: formatProjectChatHistory(messages, trigger),
        },
        projectChat: {
          kind: 'application',
          value: [
            `This task was started by project chat message ${trigger.messageId}.`,
            task
              ? `Reply to task thread cloud://projects/${project.id}/todos/${task.id}.`
              : `Reply to project chat cloud://projects/${project.id}/chat.`,
            'Your final response is public to project chat members.',
          ].join('\n'),
        },
        projectChatAgent: {
          kind: 'application',
          value: agent.systemPrompt
            ? `You are ${agent.name}, a project chat AI member.\n${agent.systemPrompt}`
            : `You are ${agent.name}, a project chat AI member.`,
        },
      },
      onError: setError,
      onRuntimeTaskOptimisticOpen: async address => {
        if (task) await services.deliveryApi?.bindTask(task.id, address, task.title)
        response = await client.startAgentResponse({
          projectId: project.id,
          taskId: task?.id,
          triggerMessageId: trigger.messageId,
          agentId: mention.id,
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
            taskId: task?.id,
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
      data-testid={task ? `cloud-task-thread-${task.id}` : 'cloud-project-group-chat'}
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-text-secondary">
          {task ? <Hash className="h-4 w-4" /> : <Users className="h-4 w-4" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-text-primary">
            {task ? task.title : `${project.name} ${t('workbench.project_chat')}`}
          </span>
          <span className="block text-xs text-text-muted">
            {task
              ? t('workbench.project_chat_task_subtitle')
              : t('workbench.project_chat_subtitle')}
          </span>
        </span>
        <span className="flex-1" />
        {!task ? (
          <span className="flex items-center -space-x-1">
            {agents
              .filter(agent => agent.status === 'active')
              .slice(0, 3)
              .map(agent => (
                <span
                  key={agent.id}
                  title={agent.name}
                  className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-violet-500/10 text-violet-600"
                >
                  <Bot className="h-3.5 w-3.5" />
                </span>
              ))}
            {onManageAgents ? (
              <button
                type="button"
                data-testid="cloud-project-group-chat-add-agent"
                onClick={onManageAgents}
                className="flex h-8 items-center gap-1 rounded-lg border border-border bg-background px-2 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
                aria-label={t('workbench.project_chat_manage_agents')}
                title={t('workbench.project_chat_manage_agents')}
              >
                <Plus className="h-3.5 w-3.5" />
                {t('workbench.project_chat_manage_agents')}
              </button>
            ) : null}
          </span>
        ) : null}
        {onClose ? (
          <button
            type="button"
            data-testid="cloud-project-group-chat-close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.project_chat_close')}
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            {t('workbench.project_chat_loading')}
          </div>
        ) : threadMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Users className="h-8 w-8 text-text-muted" />
            <p className="mt-3 text-sm font-medium text-text-primary">
              {task
                ? t('workbench.project_chat_task_empty_title')
                : t('workbench.project_chat_empty_title')}
            </p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-text-muted">
              {task
                ? t('workbench.project_chat_task_empty_description')
                : t('workbench.project_chat_empty_description')}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {threadMessages.map(message => (
              <ChatMessage
                key={message.messageId}
                message={message}
                mine={
                  message.sender.type === 'user' &&
                  String(message.sender.id) === String(chatCurrentUserId ?? currentUserId ?? '')
                }
                showTask={!task}
              />
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-border px-5 py-3">
        {error || !client ? (
          <p className="mb-2 text-xs text-destructive">
            {error ?? t('workbench.project_chat_cloud_required')}
          </p>
        ) : null}
        <div className="relative mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-border bg-background p-2 shadow-sm focus-within:border-focus">
          {mentionQuery !== null ? (
            <div
              data-testid="cloud-project-chat-mention-menu"
              className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-xl border border-border bg-background p-1.5 shadow-lg"
            >
              {mentionCandidates.length === 0 ? (
                <p className="px-3 py-2 text-xs text-text-muted">
                  {t('workbench.project_chat_no_mention_matches')}
                </p>
              ) : (
                mentionCandidates.slice(0, 8).map(candidate => (
                  <button
                    key={`${candidate.type}:${candidate.id}`}
                    type="button"
                    data-testid={`cloud-project-chat-mention-${candidate.type}-${candidate.id}`}
                    onClick={() => {
                      setDraft(insertMention(draft, candidate.label))
                      setMentions(current => [
                        ...current.filter(
                          mention => mention.type !== candidate.type || mention.id !== candidate.id
                        ),
                        candidate,
                      ])
                    }}
                    className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left hover:bg-muted"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-text-secondary">
                      {candidate.type === 'agent' ? (
                        <Bot className="h-3.5 w-3.5 text-violet-600" />
                      ) : (
                        candidate.label.slice(0, 1).toUpperCase()
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{candidate.label}</span>
                    <span className="text-xs text-text-muted">
                      {candidate.type === 'agent'
                        ? t('workbench.project_chat_agent_label')
                        : t('workbench.project_chat_member_label')}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
          <textarea
            data-testid="cloud-project-group-chat-composer"
            value={draft}
            disabled={!client}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void sendMessage()
              }
            }}
            rows={1}
            placeholder={
              task
                ? t('workbench.project_chat_task_placeholder')
                : t('workbench.project_chat_placeholder')
            }
            className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted disabled:cursor-not-allowed"
          />
          <button
            type="button"
            data-testid="cloud-project-group-chat-send"
            disabled={!client || !draft.trim() || sending}
            onClick={() => void sendMessage()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-text-primary text-background disabled:opacity-30"
            aria-label={t('workbench.project_chat_send')}
          >
            {sending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
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

function mentionQueryFromDraft(draft: string): string | null {
  const match = draft.match(/(?:^|\s)@([^\s@]*)$/u)
  return match ? match[1] : null
}

function insertMention(draft: string, label: string): string {
  return draft.replace(/(?:^|\s)@([^\s@]*)$/u, match => {
    const prefix = match.startsWith(' ') ? ' ' : ''
    return `${prefix}@${label} `
  })
}

function ChatMessage({
  message,
  mine,
  showTask,
}: {
  message: ProjectChatMessage
  mine: boolean
  showTask: boolean
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
  return (
    <article
      data-testid={`cloud-project-chat-message-${message.messageId}`}
      data-side={mine ? 'right' : 'left'}
      className={cn('flex gap-2.5', mine && 'flex-row-reverse')}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
          isAgent ? 'bg-violet-500/10 text-violet-600' : 'bg-muted text-text-secondary'
        )}
      >
        {isAgent ? <Bot className="h-4 w-4" /> : message.sender.name.slice(0, 1).toUpperCase()}
      </span>
      <span className={cn('min-w-0 max-w-[78%]', mine && 'items-end')}>
        <span
          className={cn(
            'mb-1 flex items-center gap-2 text-xs text-text-muted',
            mine && 'justify-end'
          )}
        >
          <span>{message.sender.name}</span>
          {showTask && message.taskId ? (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
              <CornerDownRight className="h-3 w-3" />
              {t('workbench.project_chat_task_thread')}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            'block whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm leading-6',
            mine ? 'bg-text-primary text-background' : 'bg-muted text-text-primary'
          )}
        >
          {text ||
            (message.type === 'agent_status'
              ? t('workbench.project_chat_processing_ellipsis')
              : '')}
        </span>
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
      </span>
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
