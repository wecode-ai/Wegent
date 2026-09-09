import { resolveMessageRunStatus, backendTaskExecution } from './taskActivityMessageUtils'
import {
  AlertCircle,
  Clock3,
  Bot,
  Check,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Copy,
  ExternalLink,
  Hash,
  LoaderCircle,
  Square,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { copyTextToClipboard } from '@/lib/clipboard'
import { openExternalUrl } from '@/lib/external-links'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { Tooltip } from '@/components/ui/tooltip'
import { executionDisplayStatus } from './executionStatus'

export interface ExecutionTaskSummary {
  title: string
  stageName: string | null
  onOpen?: () => void
}

type TaskExecutionStatusKind =
  | 'waiting_approval'
  | 'queued'
  | 'starting'
  | 'waiting_runtime'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'unknown'
  | 'interrupted'

function taskExecutionStatusKind(status: string): TaskExecutionStatusKind {
  if (status.toLowerCase() === 'interrupted') return 'interrupted'
  return executionDisplayStatus(status) ?? 'unknown'
}

export function TaskExecutionStatusControl({
  taskId,
  status,
  error,
  note,
  approvalLabel,
}: {
  taskId: string
  status: string
  error?: string | null
  note?: string | null
  approvalLabel?: string
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const kind = taskExecutionStatusKind(status)
  const labels: Record<TaskExecutionStatusKind, string> = {
    waiting_approval: approvalLabel ?? t('workbench.queue_state_pending_approval'),
    queued: t('workbench.queue_state_queued'),
    starting: t('workbench.queue_state_starting'),
    waiting_runtime: t('workbench.queue_state_waiting_runtime'),
    running: t('workbench.queue_state_running'),
    cancelling: t('workbench.queue_state_cancelling'),
    succeeded: t('workbench.task_activity_status_succeeded'),
    failed: t('workbench.task_activity_status_failed'),
    cancelled: t('workbench.queue_state_cancelled'),
    skipped: t('workbench.queue_state_skipped'),
    unknown: t('workbench.queue_state_unknown'),
    interrupted: t('workbench.task_activity_status_interrupted'),
  }
  const label = labels[kind]
  const Icon =
    kind === 'succeeded'
      ? CircleCheck
      : kind === 'failed'
        ? AlertCircle
        : kind === 'cancelled' || kind === 'skipped' || kind === 'interrupted'
          ? CircleSlash
          : ['waiting_approval', 'queued', 'waiting_runtime'].includes(kind)
            ? Clock3
            : LoaderCircle
  const animated = ['starting', 'running', 'cancelling'].includes(kind)

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  const copyDetails = async () => {
    const details = [
      `${t('workbench.task_activity_status_label')}: ${label}`,
      error ? `${t('workbench.task_activity_error_label')}: ${error}` : null,
      note ? `${t('workbench.task_activity_note_label')}: ${note}` : null,
    ]
      .filter(Boolean)
      .join('\n')
    await copyTextToClipboard(details)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <span ref={rootRef} className="task-detail-execution-status-control">
      <Tooltip label={label} side="bottom" align="end">
        <button
          type="button"
          data-testid={`cloud-task-activity-execution-status-${taskId}`}
          data-status={kind}
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          className="task-detail-execution-status-trigger"
        >
          {animated ? (
            <CompositedSpinner icon={Icon} className="h-4 w-4" />
          ) : (
            <Icon className="h-4 w-4" />
          )}
        </button>
      </Tooltip>
      {open ? (
        <span
          role="dialog"
          aria-label={t('workbench.task_activity_status_details')}
          data-testid={`cloud-task-activity-execution-details-${taskId}`}
          className="task-detail-execution-status-popover"
        >
          <span className="task-detail-execution-status-popover-head">
            <span className="task-detail-execution-status-popover-title">
              {animated ? (
                <CompositedSpinner icon={Icon} className="h-4 w-4" />
              ) : (
                <Icon className="h-4 w-4" />
              )}
              {label}
            </span>
            <button
              type="button"
              onClick={() => void copyDetails()}
              className="task-detail-execution-copy"
              aria-label={t('workbench.task_activity_copy_details')}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? t('workbench.task_activity_copied') : t('workbench.task_activity_copy')}
            </button>
          </span>
          {error ? (
            <span
              data-testid={`cloud-task-activity-execution-error-${taskId}`}
              className="task-detail-execution-status-detail is-error"
            >
              <span>{t('workbench.task_activity_error_label')}</span>
              <span>{error}</span>
            </span>
          ) : null}
          {note ? (
            <span
              data-testid={`cloud-task-activity-execution-note-${taskId}`}
              className="task-detail-execution-status-detail"
            >
              <span>{t('workbench.task_activity_note_label')}</span>
              <span>{note}</span>
            </span>
          ) : null}
          {!error && !note ? (
            <span className="task-detail-execution-status-empty">
              {t('workbench.task_activity_no_status_details')}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}

export function ChatMessage({
  message,
  mine,
  compact = false,
  plain = false,
  taskAiState,
  taskSummary,
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
  taskSummary?: ExecutionTaskSummary
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
  const normalizedText = text.replace(/\s+/g, ' ').trim()
  const summaryText =
    normalizedText.length > 240 ? `${normalizedText.slice(0, 240).trimEnd()}…` : normalizedText
  const backendExecution = isAgent ? backendTaskExecution(message) : null
  const openBackendExecution = backendExecution
    ? () => {
        void openExternalUrl(backendExecution.executionUrl).catch(error => {
          console.error('[Wework] Failed to open Wegent task execution', error)
        })
      }
    : undefined
  const openExecution = onOpenExecution ?? openBackendExecution
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
      ) : message.type === 'agent_status' && !backendExecution ? (
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
          <CompositedSpinner className="h-3 w-3" />
          {t('workbench.project_chat_processing')}
        </span>
      ) : null}
      {backendExecution ? (
        <div
          data-testid={`cloud-task-activity-backend-task-${message.messageId}`}
          className="mt-2 flex min-w-0 items-center justify-between gap-3 rounded-lg bg-muted px-2.5 py-2 text-xs"
        >
          <span className="inline-flex min-w-0 items-center gap-1.5 text-text-secondary">
            <Hash className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {t('workbench.task_activity_backend_task', { id: backendExecution.taskId })}
            </span>
          </span>
          <button
            type="button"
            data-testid={`cloud-task-activity-open-backend-task-${message.messageId}`}
            onClick={openBackendExecution}
            className="inline-flex shrink-0 items-center gap-1 text-blue-600 hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('workbench.task_activity_open_in_task_page')}
          </button>
        </div>
      ) : null}
      {isAgent && !compact && openExecution && !backendExecution ? (
        <button
          type="button"
          data-testid={`cloud-task-activity-open-execution-${message.messageId}`}
          onClick={openExecution}
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
    if (isAgent && (!plain || taskSummary)) {
      return (
        <article
          data-testid={`cloud-task-activity-message-${message.messageId}`}
          data-runtime-task-id={message.runtimeAddress?.taskId}
          data-side="left"
          className="task-detail-ai-run-card"
        >
          <div className="task-detail-ai-run-header">
            {avatar}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-text-primary">
                  {taskSummary?.title ?? message.sender.name}
                </span>
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                  {taskSummary?.stageName ??
                    (isSubagent
                      ? t('workbench.task_activity_subagent_execution')
                      : t('workbench.task_activity_ai_execution'))}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <span>{message.createdAt.slice(5, 16).replace('T', ' ')}</span>
                {runId ? <span>Run {runId.slice(0, 8)}</span> : null}
                {modelName ? <span>{modelName}</span> : null}
              </div>
            </div>
            <ExecutionStatusBadge
              messageId={message.messageId}
              status={runStatus}
              onOpenExecution={openExecution}
              onStopExecution={onStopExecution}
              stopping={stopping}
            />
          </div>
          <div className="task-detail-ai-run-body">
            {summaryText ? (
              <p
                data-testid={`cloud-task-activity-task-summary-${message.messageId}`}
                className="task-detail-ai-run-summary"
              >
                {summaryText}
              </p>
            ) : null}
            {taskSummary?.onOpen ? (
              <button
                type="button"
                data-testid={`cloud-task-activity-open-task-${message.messageId}`}
                onClick={taskSummary.onOpen}
                className="task-detail-ai-run-open-task"
              >
                {t('workbench.task_activity_open_task')}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </article>
      )
    }

    return (
      <article
        data-testid={`cloud-task-activity-message-${message.messageId}`}
        data-runtime-task-id={message.runtimeAddress?.taskId}
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
              messageId={message.messageId}
              status={runStatus}
              onOpenExecution={openExecution}
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
      data-runtime-task-id={message.runtimeAddress?.taskId}
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
        {backendExecution ? (
          <ExecutionStatusBadge
            messageId={message.messageId}
            status={runStatus}
            onOpenExecution={openExecution}
          />
        ) : null}
      </header>
      <div className="px-4 py-4">{body}</div>
    </article>
  )
}

function ExecutionStatusBadge({
  messageId,
  status,
  onOpenExecution,
  onStopExecution,
  stopping = false,
}: {
  messageId: string
  status: string
  onOpenExecution?: () => void
  onStopExecution?: () => void
  stopping?: boolean
}) {
  const { t } = useTranslation('common')
  const kind = taskExecutionStatusKind(status)
  const terminal = ['succeeded', 'failed', 'cancelled', 'skipped', 'interrupted'].includes(kind)
  const labels: Record<TaskExecutionStatusKind, string> = {
    waiting_approval: t('workbench.queue_state_pending_approval'),
    queued: t('workbench.queue_state_queued'),
    starting: t('workbench.queue_state_starting'),
    waiting_runtime: t('workbench.queue_state_waiting_runtime'),
    running: t('workbench.queue_state_running'),
    cancelling: t('workbench.queue_state_cancelling'),
    succeeded: t('workbench.project_chat_completed'),
    failed: t('workbench.task_activity_status_failed'),
    cancelled: t('workbench.queue_state_cancelled'),
    skipped: t('workbench.queue_state_skipped'),
    unknown: t('workbench.queue_state_unknown'),
    interrupted: t('workbench.task_activity_status_interrupted'),
  }
  const StatusIcon =
    kind === 'succeeded'
      ? Check
      : kind === 'failed'
        ? AlertCircle
        : kind === 'cancelled' || kind === 'skipped' || kind === 'interrupted'
          ? CircleSlash
          : ['waiting_approval', 'queued', 'waiting_runtime'].includes(kind)
            ? Clock3
            : LoaderCircle
  const animated = ['starting', 'running', 'cancelling'].includes(kind)
  const statusContent = (
    <>
      {animated ? (
        <CompositedSpinner icon={StatusIcon} className="h-3 w-3" />
      ) : (
        <StatusIcon className="h-3 w-3" />
      )}
      {labels[kind]}
    </>
  )

  return (
    <span
      className={cn('task-detail-execution-pill', !onOpenExecution && 'is-static')}
      data-status={kind}
    >
      <button
        type="button"
        data-testid={`cloud-task-activity-execution-badge-${messageId}`}
        data-status={kind}
        aria-label={labels[kind]}
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
      {onStopExecution ? (
        <button
          type="button"
          disabled={terminal || stopping}
          title={t('workbench.task_activity_stop_execution')}
          aria-label={t('workbench.task_activity_stop_execution')}
          className="task-detail-execution-stop"
          onClick={event => {
            event.stopPropagation()
            onStopExecution()
          }}
        >
          {stopping ? <CompositedSpinner className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        </button>
      ) : null}
    </span>
  )
}
