import { CornerDownRight, MoreHorizontal, Trash2 } from 'lucide-react'
import type {
  GuidanceWorkbenchMessage,
  QueuedWorkbenchMessage,
} from '@/types/workbench'

interface ConversationQueuePanelProps {
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  onCancelQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onCancelGuidanceMessage?: (id: string) => void
}

export function ConversationQueuePanel({
  queuedMessages,
  guidanceMessages,
  onCancelQueuedMessage,
  onSendQueuedAsGuidance,
  onCancelGuidanceMessage,
}: ConversationQueuePanelProps) {
  if (queuedMessages.length === 0 && guidanceMessages.length === 0) {
    return null
  }

  return (
    <div
      data-testid="conversation-queue-panel"
      className="mb-2 rounded-[18px] border border-border bg-base px-3 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.06)]"
    >
      <div className="flex flex-col gap-1">
        {queuedMessages.map((message, index) => (
          <QueueRow
            key={message.id}
            id={message.id}
            index={index + 1}
            content={message.content}
            status={message.status}
            mode="queue"
            onGuide={onSendQueuedAsGuidance}
            onCancel={onCancelQueuedMessage}
          />
        ))}
        {guidanceMessages.map((message, index) => (
          <QueueRow
            key={message.id}
            id={message.id}
            index={queuedMessages.length + index + 1}
            content={message.content}
            status={message.status}
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
  index: number
  content: string
  status: QueuedWorkbenchMessage['status'] | GuidanceWorkbenchMessage['status']
  mode: 'queue' | 'guidance'
  onGuide?: (id: string) => void
  onCancel?: (id: string) => void
}

function QueueRow({
  id,
  index,
  content,
  status,
  mode,
  onGuide,
  onCancel,
}: QueueRowProps) {
  const isBusy = status === 'sending'
  const label = mode === 'guidance' ? '引导' : String(index)

  return (
    <div
      data-testid={`conversation-queue-row-${id}`}
      className="flex min-h-9 items-center gap-2 rounded-xl px-1.5 text-[13px] text-[#777] hover:bg-surface"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-[#aaa]" />
        <span className="shrink-0 text-[#777]">{label}</span>
        <span className="truncate text-[#666]">{content}</span>
        {status === 'failed' && (
          <span className="shrink-0 text-xs text-red-500">发送失败</span>
        )}
        {status === 'expired' && (
          <span className="shrink-0 text-xs text-[#999]">已过期</span>
        )}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {mode === 'queue' && (
          <button
            type="button"
            data-testid={`queue-guidance-button-${id}`}
            onClick={() => onGuide?.(id)}
            disabled={isBusy}
            className="flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-lg px-2 text-xs text-[#888] hover:bg-[#f1f1f1] hover:text-[#555] disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:min-w-0"
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
          className="flex h-11 min-w-[44px] items-center justify-center rounded-lg text-[#999] hover:bg-[#f1f1f1] hover:text-[#666] disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:min-w-0 sm:px-2"
          aria-label="移除队列消息"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid={`queue-more-button-${id}`}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-lg text-[#999] hover:bg-[#f1f1f1] hover:text-[#666] sm:h-8 sm:min-w-0 sm:px-2"
          aria-label="更多队列操作"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
