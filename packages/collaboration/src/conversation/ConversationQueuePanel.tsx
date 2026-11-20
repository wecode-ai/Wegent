import { SortableRoot, SortableItem, SortableHandle } from '../controls/Sortable'
import {
  canReorderQueuedMessage,
  type GuidanceWorkbenchMessage,
  type QueuedWorkbenchMessage,
} from '@wegent/chat-core/conversation-queue'
import { CornerDownRight, GripVertical, MoreHorizontal, Pencil, Trash2, Zap } from 'lucide-react'
import { useMemo } from 'react'
import { ActionMenu } from '../controls/ActionMenu'
import { controlActionDensity, controlIconActionDensity } from '../controls/recipes'
import type { CollaborationTranslate } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'

export interface ConversationQueuePanelProps {
  translate: CollaborationTranslate
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  onCancelQueuedMessage?: (id: string) => void
  onForceStartQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onInterruptAndSendQueuedMessage?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onReorderQueuedMessages?: (sourceId: string, targetId: string) => void
  queuePaused?: boolean
  onResumeQueue?: () => void
  onCancelGuidanceMessage?: (id: string) => void
}

export function ConversationQueuePanel({
  translate: t,
  queuedMessages,
  guidanceMessages,
  onCancelQueuedMessage,
  onForceStartQueuedMessage,
  onSendQueuedAsGuidance,
  onInterruptAndSendQueuedMessage,
  onEditQueuedMessage,
  onReorderQueuedMessages,
  queuePaused = false,
  onResumeQueue,
  onCancelGuidanceMessage,
}: ConversationQueuePanelProps) {
  const visibleQueuedMessages = useMemo(
    () => queuedMessages.filter(message => !message.awaitingGuidanceAcceptance),
    [queuedMessages]
  )
  const queuedMessageIds = useMemo(
    () => visibleQueuedMessages.filter(canReorderQueuedMessage).map(message => message.id),
    [visibleQueuedMessages]
  )
  const displayedQueuedMessages = useMemo(
    () =>
      [...visibleQueuedMessages].sort(
        (left, right) =>
          queuedMessageDisplayPriority(left.status) - queuedMessageDisplayPriority(right.status)
      ),
    [visibleQueuedMessages]
  )
  if (visibleQueuedMessages.length === 0 && guidanceMessages.length === 0) {
    return null
  }

  return (
    <div
      data-testid="conversation-queue-panel"
      className="mb-1 rounded-[18px] border border-border bg-base px-2 py-1 shadow-[0_8px_24px_rgba(15,23,42,0.05)]"
    >
      <SortableRoot
        value={queuedMessageIds}
        aria-label={t('conversation.queue.reorder')}
        onValueChange={(_ids, details) => {
          const targetId = queuedMessageIds[details.toIndex]
          if (!onReorderQueuedMessages || !targetId || details.key === targetId) {
            details.cancel()
            return
          }
          onReorderQueuedMessages(details.key, targetId)
        }}
      >
        {state => {
          const draft = state.moving?.order ?? state.value
          const byId = new Map(displayedQueuedMessages.map(message => [message.id, message]))
          let next = 0
          const renderedMessages = displayedQueuedMessages
            .map(message =>
              queuedMessageIds.includes(message.id) ? byId.get(draft[next++]) : message
            )
            .filter((message): message is (typeof displayedQueuedMessages)[number] =>
              Boolean(message)
            )
          return (
            <div className="flex flex-col">
              {queuePaused && visibleQueuedMessages.length > 0 && (
                <div className="flex h-8 items-center justify-between gap-2 px-2 text-xs text-text-muted">
                  <span>{t('conversation.queue.paused')}</span>
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="resume-queue-button"
                    onClick={onResumeQueue}
                    disabled={!onResumeQueue}
                    className={`${controlActionDensity.dense} rounded-lg px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary`}
                  >
                    {t('conversation.queue.resume')}
                  </ControlButton>
                </div>
              )}
              {guidanceMessages.map(message => (
                <QueueRow
                  translate={t}
                  key={message.id}
                  id={message.id}
                  content={message.content}
                  status={message.status}
                  error={message.error}
                  mode="guidance"
                  onCancel={onCancelGuidanceMessage}
                  onInterrupt={onInterruptAndSendQueuedMessage}
                />
              ))}
              {renderedMessages.map(message => (
                <QueueRow
                  translate={t}
                  key={message.id}
                  id={message.id}
                  content={message.content}
                  status={message.status}
                  error={message.error}
                  notice={message.notice}
                  deliveryMode={message.deliveryMode}
                  runtimeQueued={message.runtimeQueued}
                  runtimeQueuePosition={message.runtimeQueuePosition}
                  mode="queue"
                  onForceStart={onForceStartQueuedMessage}
                  onGuide={onSendQueuedAsGuidance}
                  onInterrupt={onInterruptAndSendQueuedMessage}
                  onEdit={onEditQueuedMessage}
                  canReorder={
                    canReorderQueuedMessage(message) &&
                    queuedMessageIds.length > 1 &&
                    Boolean(onReorderQueuedMessages)
                  }
                  onCancel={onCancelQueuedMessage}
                />
              ))}
            </div>
          )
        }}
      </SortableRoot>
    </div>
  )
}

function queuedMessageDisplayPriority(status: QueuedWorkbenchMessage['status']): number {
  if (status === 'sending') return 0
  if (status === 'queued') return 1
  return 2
}

interface QueueRowProps {
  translate: CollaborationTranslate
  id: string
  content: string
  status: QueuedWorkbenchMessage['status'] | GuidanceWorkbenchMessage['status']
  error?: string
  notice?: string
  deliveryMode?: QueuedWorkbenchMessage['deliveryMode']
  runtimeQueued?: boolean
  runtimeQueuePosition?: number | null
  mode: 'queue' | 'guidance'
  onForceStart?: (id: string) => void
  onGuide?: (id: string) => void
  onEdit?: (id: string) => void
  onInterrupt?: (id: string) => void
  canReorder?: boolean
  onCancel?: (id: string) => void
}

function QueueRow({
  translate: t,
  id,
  content,
  status,
  error,
  notice,
  deliveryMode,
  runtimeQueued = false,
  runtimeQueuePosition,
  mode,
  onForceStart,
  onGuide,
  onEdit,
  onInterrupt,
  canReorder = false,
  onCancel,
}: QueueRowProps) {
  const isBusy = status === 'sending'
  const isSendingGuidance = isBusy && deliveryMode === 'guidance'
  const showInlineInterrupt = Boolean(onInterrupt) && !runtimeQueued
  const statusText =
    status === 'failed'
      ? (error ?? t('conversation.queue.send_failed'))
      : status === 'expired'
        ? (error ?? t('conversation.queue.expired'))
        : status === 'sending'
          ? isSendingGuidance
            ? t('conversation.queue.guiding')
            : (notice ?? t('conversation.queue.sending'))
          : runtimeQueued
            ? runtimeQueuePosition
              ? t('workbench.runtime_follow_up_queued_position', undefined, {
                  position: runtimeQueuePosition,
                })
              : t('workbench.runtime_follow_up_queued')
            : null

  return (
    <SortableItem
      value={mode === 'guidance' ? `guidance:${id}` : id}
      label={content}
      disabled={!canReorder}
      data-testid={`conversation-queue-row-${id}`}
      className={[
        'flex min-h-8 items-center gap-2 rounded-xl px-2 text-sm text-text-secondary hover:bg-surface',
      ].join(' ')}
    >
      {canReorder && (
        <SortableHandle
          type="button"
          data-testid={`queue-drag-handle-${id}`}
          className="shrink-0 text-text-muted hover:bg-muted"
          aria-label={t('conversation.queue.reorder')}
          title={t('conversation.queue.reorder')}
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </SortableHandle>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="truncate text-text-secondary">{content}</span>
        {statusText && (
          <span
            className={[
              'max-w-[14rem] shrink-0 truncate text-xs',
              status === 'failed' ? 'text-red-500' : 'text-text-muted',
            ].join(' ')}
          >
            {statusText}
          </span>
        )}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {runtimeQueued && onForceStart && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`queue-force-start-button-${id}`}
            onClick={() => onForceStart(id)}
            disabled={isBusy}
            className={`${controlActionDensity.dense} inline-flex min-w-11 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 md:min-w-0`}
            aria-label={t('workbench.runtime_follow_up_force_start')}
          >
            <Zap className="h-3.5 w-3.5" />
            <span>{t('workbench.runtime_follow_up_force_start')}</span>
          </ControlButton>
        )}
        {mode === 'queue' && !runtimeQueued && !isSendingGuidance && onGuide && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`queue-guidance-button-${id}`}
            onClick={() => onGuide?.(id)}
            disabled={isBusy}
            className={`${controlActionDensity.dense} inline-flex min-w-11 items-center justify-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 md:min-w-0`}
            aria-label={t('conversation.queue.send_as_guidance')}
          >
            <CornerDownRight className="h-3.5 w-3.5" />
            <span>{t('conversation.queue.guide')}</span>
          </ControlButton>
        )}
        {showInlineInterrupt && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`queue-interrupt-button-${id}`}
            onClick={() => onInterrupt?.(id)}
            className={`${controlActionDensity.dense} inline-flex min-w-11 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary md:min-w-0`}
            aria-label={t('workbench.interrupt_and_send')}
          >
            <Zap className="h-3.5 w-3.5" />
            <span>{t('workbench.interrupt_and_send_short')}</span>
          </ControlButton>
        )}
        {!isSendingGuidance && onCancel && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`queue-cancel-button-${id}`}
            onClick={() => onCancel?.(id)}
            disabled={isBusy}
            className={`${runtimeQueued ? controlActionDensity.dense : controlIconActionDensity.dense} inline-flex min-w-11 items-center justify-center gap-1 rounded-lg px-2 text-xs text-text-muted hover:bg-muted hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50 md:min-w-7`}
            aria-label={runtimeQueued ? t('common.cancel') : t('conversation.queue.remove')}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {runtimeQueued && <span>{t('common.cancel')}</span>}
          </ControlButton>
        )}
        {mode === 'queue' && !runtimeQueued && !isBusy && onEdit && (
          <ActionMenu
            density="dense"
            ariaLabel={t('conversation.queue.more')}
            testId={`queue-more-button-${id}`}
            icon={MoreHorizontal}
            triggerClassName="inline-flex items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-secondary"
            items={[
              {
                label: t('conversation.queue.edit'),
                icon: Pencil,
                testId: `queue-edit-button-${id}`,
                onSelect: () => onEdit?.(id),
              },
            ]}
          />
        )}
      </div>
    </SortableItem>
  )
}
