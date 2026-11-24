import type { ReactNode } from 'react'
import type { StandInInboxWork } from '@/api/standIn'
import {
  WORKSPACE_ACTIVITY_ROW_CLASS,
  WorkspaceActivityRowContent,
} from '@/components/chat/WorkspaceActivityRowContent'
import { standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { Button } from '@wegent/collaboration/markdown/Button'
import { ChevronRight, ClipboardList, List } from 'lucide-react'

export type StandInSidebarTasks = {
  items: RuntimeTaskReminderItem[]
  inbox: StandInInboxWork[]
  onAllActivity(): void
}

export function StandInSidebarTaskList({
  tasks,
  delegations,
  onOpenTask,
}: {
  tasks?: StandInSidebarTasks
  delegations: { key: string; createdAt: number; content: ReactNode }[]
  onOpenTask?(address: RuntimeTaskAddress): void | Promise<void>
}) {
  const { t } = useTranslation('common')
  const title = t('standIn.delegation.panel')
  const allActivity = t('standIn.workspace.details_all_activity')
  const inboxByTask = new Map(tasks?.inbox.map(work => [work.taskId, work]))
  const taskRows =
    tasks?.items.map(item => {
      const work = inboxByTask.get(item.task.taskId)
      const archived = item.task.status === 'archived'
      const status = archived
        ? t('workbench.settings_category_archived')
        : work && work.status !== 'sent'
          ? t(`standIn.workspace.inbox_${work.status}`)
          : t(`standIn.personal.activity_${standInState(item).status}`)
      return {
        key: `task:${item.key}`,
        createdAt: new Date(item.task.createdAt ?? item.task.updatedAt ?? 0).getTime() || 0,
        content: (
          <Button
            variant="unstyled"
            type="button"
            data-testid="stand-in-sidebar-task"
            onClick={() => {
              if (!archived && onOpenTask && (!work || work.task)) void onOpenTask(item.address)
              else tasks.onAllActivity()
            }}
            className={WORKSPACE_ACTIVITY_ROW_CLASS}
          >
            <WorkspaceActivityRowContent
              icon={
                <ClipboardList
                  aria-hidden="true"
                  className="mt-0.5 size-6 shrink-0 p-1 text-text-secondary"
                />
              }
              title={item.task.title}
              status={status}
            />
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
          </Button>
        ),
      }
    }) ?? []
  const rows = [...delegations, ...taskRows].sort((left, right) => right.createdAt - left.createdAt)
  return (
    <aside
      id="stand-in-delegation-panel"
      aria-label={title}
      data-testid="stand-in-delegation-panel"
      className="flex min-w-0 flex-1 flex-col border-border bg-background md:w-80 md:flex-none md:border-l"
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        {tasks && (
          <Button
            variant="unstyled"
            type="button"
            aria-label={allActivity}
            title={allActivity}
            data-testid="stand-in-sidebar-all-tasks"
            onClick={tasks.onAllActivity}
            className="flex size-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted md:size-8"
          >
            <List aria-hidden="true" className="size-4" />
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {rows.length ? (
          <ul className="flex flex-col gap-1" data-testid="stand-in-sidebar-activity-list">
            {rows.map(row => (
              <li key={row.key}>{row.content}</li>
            ))}
          </ul>
        ) : (
          <p className="px-2 py-1 text-sm text-text-muted">{t('standIn.delegation.panelEmpty')}</p>
        )}
      </div>
    </aside>
  )
}
