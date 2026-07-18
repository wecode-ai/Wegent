import { useMemo, useState } from 'react'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  type DragEndEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CornerDownRight, GripVertical, MoreHorizontal, Pencil, Trash2, Zap } from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'

interface ConversationQueuePanelProps {
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  onCancelQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  onInterruptAndSendQueuedMessage?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onReorderQueuedMessages?: (sourceId: string, targetId: string) => void
  queuePaused?: boolean
  onResumeQueue?: () => void
  onCancelGuidanceMessage?: (id: string) => void
}

export function ConversationQueuePanel({
  queuedMessages,
  guidanceMessages,
  onCancelQueuedMessage,
  onSendQueuedAsGuidance,
  onInterruptAndSendQueuedMessage,
  onEditQueuedMessage,
  onReorderQueuedMessages,
  queuePaused = false,
  onResumeQueue,
  onCancelGuidanceMessage,
}: ConversationQueuePanelProps) {
  const { t } = useTranslation('chat')
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const queuedMessageIds = useMemo(
    () => queuedMessages.filter(message => message.status === 'queued').map(message => message.id),
    [queuedMessages]
  )
  const displayedQueuedMessages = useMemo(
    () =>
      [...queuedMessages].sort(
        (left, right) =>
          queuedMessageDisplayPriority(left.status) - queuedMessageDisplayPriority(right.status)
      ),
    [queuedMessages]
  )
  const activeMessage = queuedMessages.find(message => message.id === activeMessageId) ?? null

  if (queuedMessages.length === 0 && guidanceMessages.length === 0) {
    return null
  }

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveMessageId(String(active.id))
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) {
      onReorderQueuedMessages?.(String(active.id), String(over.id))
    }
    setActiveMessageId(null)
  }

  return (
    <div
      data-testid="conversation-queue-panel"
      className="mb-1 rounded-[18px] border border-border bg-base px-2 py-1 shadow-[0_8px_24px_rgba(15,23,42,0.05)]"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={() => setActiveMessageId(null)}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={queuedMessageIds} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col">
            {queuePaused && queuedMessages.length > 0 && (
              <div className="flex h-8 items-center justify-between gap-2 px-2 text-xs text-text-muted">
                <span>{t('queue.paused')}</span>
                <button
                  type="button"
                  data-testid="resume-queue-button"
                  onClick={onResumeQueue}
                  className="h-8 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
                >
                  {t('queue.resume')}
                </button>
              </div>
            )}
            {guidanceMessages.map(message => (
              <QueueRow
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
            {displayedQueuedMessages.map(message => (
              <QueueRow
                key={message.id}
                id={message.id}
                content={message.content}
                status={message.status}
                error={message.error}
                notice={message.notice}
                mode="queue"
                onGuide={onSendQueuedAsGuidance}
                onInterrupt={onInterruptAndSendQueuedMessage}
                onEdit={onEditQueuedMessage}
                canReorder={message.status === 'queued' && queuedMessageIds.length > 1}
                onCancel={onCancelQueuedMessage}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeMessage && <QueueDragPreview content={activeMessage.content} />}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

function queuedMessageDisplayPriority(status: QueuedWorkbenchMessage['status']): number {
  if (status === 'sending') return 0
  if (status === 'queued') return 1
  return 2
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
  onInterrupt?: (id: string) => void
  canReorder?: boolean
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
  onInterrupt,
  canReorder = false,
  onCancel,
}: QueueRowProps) {
  const { t } = useTranslation('common')
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !canReorder })
  const isBusy = status === 'sending'
  const statusText =
    status === 'failed'
      ? (error ?? '发送失败')
      : status === 'expired'
        ? (error ?? '已过期')
        : status === 'sending'
          ? (notice ?? '正在发送')
          : null

  return (
    <div
      ref={setNodeRef}
      data-testid={`conversation-queue-row-${id}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={[
        'flex min-h-8 items-center gap-2 rounded-xl px-2 text-sm text-text-secondary hover:bg-surface',
        isDragging ? 'opacity-30' : '',
      ].join(' ')}
    >
      {canReorder && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          data-testid={`queue-drag-handle-${id}`}
          {...attributes}
          {...listeners}
          className="flex h-8 w-4 shrink-0 touch-none cursor-grab items-center justify-center rounded text-text-muted hover:bg-muted active:cursor-grabbing"
          aria-label="拖拽调整消息顺序"
          title="拖拽调整消息顺序"
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </button>
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
        {mode === 'guidance' && (
          <button
            type="button"
            data-testid={`queue-interrupt-button-${id}`}
            onClick={() => onInterrupt?.(id)}
            className="flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary sm:h-8 sm:min-w-0"
            aria-label={t('workbench.interrupt_and_send')}
          >
            <Zap className="h-3.5 w-3.5" />
            <span>{t('workbench.interrupt_and_send')}</span>
          </button>
        )}
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
              {
                label: t('workbench.interrupt_and_send'),
                icon: Zap,
                testId: `queue-interrupt-button-${id}`,
                onSelect: () => onInterrupt?.(id),
              },
            ]}
          />
        )}
      </div>
    </div>
  )
}

function QueueDragPreview({ content }: { content: string }) {
  return (
    <div
      data-testid="queue-drag-overlay"
      className="flex min-h-8 max-w-[28rem] items-center gap-2 rounded-xl border border-border bg-base px-3 text-sm text-text-secondary shadow-lg"
    >
      <GripVertical className="h-4 w-4 shrink-0 text-text-muted" />
      <span className="truncate">{content}</span>
    </div>
  )
}
