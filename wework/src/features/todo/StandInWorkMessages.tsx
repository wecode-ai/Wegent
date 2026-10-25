import { useEffect, useState } from 'react'
import { ArrowRight, GripVertical, Split } from 'lucide-react'
import type { StandInExecutorApi, StandInInboxMessage, StandInInboxWork } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import type { StandInWorkDrag } from './useStandInWorkOrganization'

export function StandInWorkMessages({
  api,
  userId,
  deviceId,
  work,
  siblings,
  busy = false,
  expanded = false,
  draggedMessageId,
  onExpandedChange,
  onDrag,
  onDragEnd,
  onChooseTarget,
  onOrganize,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  work: StandInInboxWork
  siblings: StandInInboxWork[]
  busy?: boolean
  expanded?: boolean
  draggedMessageId?: string
  onExpandedChange(open: boolean): void
  onDrag(value: StandInWorkDrag): void
  onDragEnd(): void
  onChooseTarget(value: StandInWorkDrag): void
  onOrganize(value: StandInWorkDrag): Promise<void>
}) {
  const { t } = useTranslation('common')
  const [messages, setMessages] = useState<StandInInboxMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const canSplit = messages.length > 1
  const canMove = siblings.some(
    value => value.id !== work.id && value.roleId === work.roleId && value.messageCount > 0
  )
  const payload = (message: StandInInboxMessage): StandInWorkDrag => ({
    workId: work.id,
    roleId: work.roleId,
    title: message.text,
    messageIds: [message.recordId],
    canSplit,
  })
  useEffect(() => {
    let active = true
    void api
      .workMessages(userId, deviceId, work.id)
      .then(value => {
        if (active) {
          setMessages(value.messages)
          setError(null)
        }
      })
      .catch(cause => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [api, userId, deviceId, work.id, work.messageCount, revision])
  return (
    <details
      open={expanded}
      onToggle={event => onExpandedChange(event.currentTarget.open)}
      className="mt-5 border-t border-border pt-3"
      data-testid="stand-in-work-messages"
    >
      <summary
        className="min-h-11 cursor-pointer py-2 text-sm md:min-h-8 md:py-1"
        data-testid="stand-in-work-messages-toggle"
      >
        {t('standIn.workspace.related_messages', { count: work.messageCount })}
      </summary>
      {error && (
        <div role="alert" className="mt-2 text-sm text-error">
          <p>{error}</p>
          <button
            type="button"
            data-testid="stand-in-messages-retry"
            onClick={() => setRevision(value => value + 1)}
            className="min-h-11 underline md:min-h-9"
          >
            {t('standIn.reload')}
          </button>
        </div>
      )}
      <div className="mt-3 space-y-2">
        {messages.map(message => (
          <div
            key={message.recordId}
            draggable={!busy && (canSplit || canMove)}
            onDragStart={event => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData(
                'application/x-wework-work',
                JSON.stringify(payload(message))
              )
              onDrag(payload(message))
            }}
            onDragEnd={onDragEnd}
            className={`group rounded-lg border border-border bg-background p-3 ${draggedMessageId === message.recordId ? 'opacity-40' : ''}`}
            data-testid={`stand-in-message-card-${message.id}`}
          >
            <div className="flex items-start gap-2">
              {(canSplit || canMove) && (
                <GripVertical
                  data-testid={`stand-in-message-drag-${message.id}`}
                  className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-xs text-text-muted">
                  {message.source.name} · {new Date(message.at).toLocaleString()}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">{message.text}</p>
              </div>
            </div>
            {(canSplit || canMove) && (
              <div className="mt-2 flex flex-wrap justify-end gap-1">
                {canMove && (
                  <button
                    type="button"
                    data-testid={`stand-in-message-move-${message.id}`}
                    disabled={busy}
                    onClick={() => onChooseTarget(payload(message))}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs text-text-muted hover:bg-muted md:min-h-8"
                  >
                    <ArrowRight className="h-4 w-4" />
                    {t('standIn.workspace.move_message')}
                  </button>
                )}
                {canSplit && (
                  <button
                    type="button"
                    data-testid={`stand-in-message-split-${message.id}`}
                    disabled={busy}
                    onClick={() => void onOrganize(payload(message))}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-muted md:min-h-8"
                  >
                    <Split className="h-4 w-4" />
                    {t('standIn.workspace.split_work')}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}
