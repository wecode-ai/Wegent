import type { StandInInboxWork } from '@/api/standIn'
import { standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { Button } from '@wegent/collaboration/markdown/Button'
import { ChevronRight } from 'lucide-react'

export function StandInSidebarTaskList({
  items,
  inbox,
  onOpenTask,
  onAllActivity,
}: {
  items: RuntimeTaskReminderItem[]
  inbox: StandInInboxWork[]
  onOpenTask?(address: RuntimeTaskAddress): void | Promise<void>
  onAllActivity(): void
}) {
  const { t } = useTranslation('common')
  const inboxByTask = new Map(inbox.map(work => [work.taskId, work]))
  const title = t('standIn.delegation.tasks')
  return (
    <section aria-label={title} className="border-t border-border py-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <Button
          variant="unstyled"
          type="button"
          data-testid="stand-in-sidebar-all-tasks"
          onClick={onAllActivity}
          className="min-h-11 rounded-md px-2 text-xs text-text-secondary hover:bg-muted md:min-h-8"
        >
          {t('standIn.workspace.details_all_activity')}
        </Button>
      </div>
      {items.length ? (
        <ul>
          {items.map(item => {
            const work = inboxByTask.get(item.task.taskId)
            const archived = item.task.status === 'archived'
            const status = archived
              ? t('workbench.settings_category_archived')
              : work && work.status !== 'sent'
                ? t(`standIn.workspace.inbox_${work.status}`)
                : t(`standIn.personal.activity_${standInState(item).status}`)
            return (
              <li key={item.key}>
                <Button
                  variant="unstyled"
                  type="button"
                  data-testid="stand-in-sidebar-task"
                  onClick={() => {
                    if (!archived && onOpenTask && (!work || work.task))
                      void onOpenTask(item.address)
                    else onAllActivity()
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted md:min-h-9"
                >
                  <span className="min-w-0 flex-1 truncate" title={item.task.title}>
                    {item.task.title}
                  </span>
                  <span className="max-w-[45%] text-right text-xs text-text-secondary">
                    {status}
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
                </Button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="px-1 py-2 text-sm text-text-secondary">
          {t('standIn.delegation.tasksEmpty')}
        </p>
      )}
    </section>
  )
}
