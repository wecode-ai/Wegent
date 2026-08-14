import { ArrowRight } from 'lucide-react'
import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { AnchorPopover } from './AnchorPopover'
import { memberNameById } from './todoShared'

type StatusHistoryEntry = NonNullable<CloudLoopItem['status_history']>[number]

const STATUS_ACTION_KEYS: Record<StatusHistoryEntry['trigger'], string> = {
  create: 'todo.status_action_create',
  user_update: 'todo.status_action_user_update',
  ai_started: 'todo.status_action_ai_started',
  ai_completed: 'todo.status_action_ai_completed',
  task_started: 'todo.status_action_task_started',
  delivery: 'todo.status_action_delivery',
  status_removed: 'todo.status_action_status_removed',
}

interface StatusHistoryPopoverProps {
  anchor: HTMLElement | null
  entries: StatusHistoryEntry[]
  projectMembers: CloudProjectMember[]
  onClose: () => void
}

export function StatusHistoryPopover({
  anchor,
  entries,
  projectMembers,
  onClose,
}: StatusHistoryPopoverProps) {
  const { t } = useTranslation('common')
  return (
    <AnchorPopover
      anchor={anchor}
      title={t('todo.status_history_title', '状态历史')}
      testId="cloud-todo-status-history-popover"
      onClose={onClose}
    >
      {entries.map((entry, index) => {
        const byName = memberNameById(projectMembers, entry.by_user_id)
        const actor = byName ?? t('todo.status_history_system', '系统/机器人')
        const toName = entry.to_status_name || t('todo.status_history_unset', '未设置')
        const isCreate = entry.trigger === 'create'
        const isAccept =
          entry.trigger === 'user_update' &&
          entry.from_status === 'in_review' &&
          entry.to_status === 'completed'
        const actionLabel = isAccept
          ? t('todo.status_action_accept', '验收')
          : t(STATUS_ACTION_KEYS[entry.trigger] ?? 'todo.status_action_user_update', entry.trigger)
        return (
          <div
            key={`${entry.at}-${index}`}
            className="rounded-md px-1.5 py-1.5"
            data-testid={`cloud-todo-status-history-entry-${index}`}
          >
            <div className="flex items-center gap-1.5 text-xs text-text-primary">
              <span className="shrink-0 font-medium">{actor}</span>
              {isCreate ? (
                <>
                  <span className="shrink-0 text-text-muted">
                    {t('todo.status_history_initial', '初始状态')}
                  </span>
                  <span className="min-w-0 truncate">{toName}</span>
                </>
              ) : (
                <>
                  <span className="min-w-0 truncate">
                    {entry.from_status_name || t('todo.status_history_unset', '未设置')}
                  </span>
                  <ArrowRight className="h-3 w-3 shrink-0 text-text-muted" />
                  <span className="min-w-0 truncate">{toName}</span>
                </>
              )}
            </div>
            <p className="mt-0.5 text-xs text-text-muted">
              {actionLabel} · {new Date(entry.at).toLocaleString()}
            </p>
          </div>
        )
      })}
    </AnchorPopover>
  )
}
