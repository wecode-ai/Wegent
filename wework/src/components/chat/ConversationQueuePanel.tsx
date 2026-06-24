import { CornerDownRight, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import type {
  GuidanceWorkbenchMessage,
  QueuedWorkbenchMessage,
} from '@/types/workbench'

interface ConversationQueuePanelProps {
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  onCancelQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onCancelGuidanceMessage?: (id: string) => void
}

export function ConversationQueuePanel({
  queuedMessages,
  guidanceMessages,
  onCancelQueuedMessage,
  onSendQueuedAsGuidance,
  onEditQueuedMessage,
  onCancelGuidanceMessage,
}: ConversationQueuePanelProps) {
  if (queuedMessages.length === 0 && guidanceMessages.length === 0) {
    return null
  }

  return (
    <div
      data-testid="conversation-queue-panel"
      className="mb-1 rounded-[18px] border border-border bg-base px-2 py-1 shadow-[0_8px_24px_rgba(15,23,42,0.05)]"
    >
      <div className="flex flex-col">
        {queuedMessages.map(message => (
          <QueueRow
            key={message.id}
            id={message.id}
            content={message.content}
            status={message.status}
            error={message.error}
            notice={message.notice}
            mode="queue"
            onGuide={onSendQueuedAsGuidance}
            onEdit={onEditQueuedMessage}
            onCancel={onCancelQueuedMessage}
          />
        ))}
        {guidanceMessages.map(message => (
          <QueueRow
            key={message.id}
            id={message.id}
            content={message.content}
            status={message.status}
            error={message.error}
            mode="guidance"
            onCancel={onCancelGuidanceMessage}
          />
        ))}
      </div>
    </div>
  )
}

interface QueueRowProps {
  id: string
  content: string
  status: QueuedWorkbenchMessage['status'] | GuidanceWorkbenchMessage['status']
  error?: string
  notice?: string
  mode: 'queue' | 'guidance'
  onGuide?: (id: string) => void
  onEdit?: (id: string) => void
  onCancel?: (id: string) => void
}

function QueueRow({
  id,
  content,
  status,
  error,
  notice,
  mode,
  onGuide,
  onEdit,
  onCancel,
}: QueueRowProps) {
  const isBusy = status === 'sending'
  const statusText =
    status === 'failed'
      ? error ?? '发送失败'
      : status === 'expired'
        ? error ?? '已过期'
        : status === 'sending'
          ? notice ?? '正在发送'
          : null

  return (
    <div
      data-testid={`conversation-queue-row-${id}`}
      className="flex min-h-8 items-center gap-2 rounded-xl px-2 text-[13px] text-text-secondary hover:bg-surface"
    >
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
        {mode === 'queue' && (
          <button
            type="button"
            data-testid={`queue-guidance-button-${id}`}
            onClick={() => onGuide?.(id)}
            disabled={isBusy}
            className="flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:min-w-0"
            aria-label="作为引导发送"
          >
            <CornerDownRight className="h-3.5 w-3.5" />
            <span>引导</span>
          </button>
        )}
        <button
          type="button"
          data-testid={`queue-cancel-button-${id}`}
          onClick={() => onCancel?.(id)}
          disabled={isBusy}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:min-w-0 sm:px-2"
          aria-label="移除队列消息"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        {mode === 'queue' && (
          <ActionMenu
            ariaLabel="更多队列操作"
            testId={`queue-more-button-${id}`}
            icon={MoreHorizontal}
            triggerClassName="flex h-11 min-w-[44px] items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-secondary sm:h-8 sm:min-w-0 sm:px-2"
            items={[
              {
                label: '编辑',
                icon: Pencil,
                testId: `queue-edit-button-${id}`,
                onSelect: () => onEdit?.(id),
              },
            ]}
          />
        )}
      </div>
    </div>
  )
}
