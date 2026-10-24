import { ArrowUpRight, ChevronRight, X } from 'lucide-react'
import { useState } from 'react'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import type { StandInExecutorApi, StandInInboxWork } from '@/api/standIn'
import { StandInWorkMessages } from './StandInWorkMessages'
import { StandInWorkConfirmation } from './StandInWorkConfirmation'

type WorkFilter = 'all' | 'waiting' | 'running' | 'completed'

export function StandInWorkList({
  items,
  onOpenTask,
  inbox = [],
  api,
  userId,
  deviceId,
  onRefresh,
  active = true,
}: {
  items: RuntimeTaskReminderItem[]
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
  inbox?: StandInInboxWork[]
  api?: StandInExecutorApi
  userId?: number
  deviceId?: string
  onRefresh?(): void
  active?: boolean
}) {
  const { t } = useTranslation('common')
  const [filter, setFilter] = useState<WorkFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const selected = items.find(item => item.key === selectedKey)
  const selectedState = selected && standInState(selected)
  const selectedWork = inbox.find(work => work.taskId === selected?.task.taskId)
  const needsStart =
    selectedWork && ['pending', 'failed', 'needs_grouping'].includes(selectedWork.status)
  const statusLabel = (item: RuntimeTaskReminderItem) => {
    const work = inbox.find(value => value.taskId === item.task.taskId)
    return work && work.status !== 'sent'
      ? t(`standIn.workspace.inbox_${work.status}`)
      : t(`standIn.personal.activity_${standInState(item).status}`)
  }
  const filterStatus = (item: RuntimeTaskReminderItem) => {
    const work = inbox.find(value => value.taskId === item.task.taskId)
    return work && ['pending', 'needs_grouping'].includes(work.status)
      ? 'waiting'
      : standInState(item).status
  }
  const visible = items.filter(item => filter === 'all' || filterStatus(item) === filter)
  return (
    <div className="flex min-h-0 flex-1" data-testid="stand-in-activity">
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        <nav aria-label={t('standIn.workspace.work_filters')} className="mb-4 flex flex-wrap gap-1">
          {(['all', 'waiting', 'running', 'completed'] as const).map(value => (
            <button
              key={value}
              type="button"
              data-testid={`stand-in-filter-${value}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`min-h-8 rounded-md px-3 text-sm ${filter === value ? 'bg-muted font-medium' : 'text-text-muted hover:bg-muted'}`}
            >
              {t(`standIn.workspace.filter_${value}`)}
              {value === 'waiting' &&
                items.some(item => filterStatus(item) === 'waiting') &&
                ` ${items.filter(item => filterStatus(item) === 'waiting').length}`}
            </button>
          ))}
        </nav>
        {!visible.length && (
          <p className="py-8 text-sm text-text-muted">
            {t(
              items.length
                ? 'standIn.workspace.no_matching_work'
                : 'standIn.personal.activity_empty'
            )}
          </p>
        )}
        <div className="divide-y divide-border" data-testid="stand-in-activity-project">
          {visible.map(item => {
            const status = standInState(item)
            return (
              <button
                key={item.key}
                type="button"
                data-testid={`stand-in-activity-task-${item.task.taskId}`}
                aria-pressed={selectedKey === item.key}
                onClick={() => {
                  setSelectedKey(item.key)
                  setError(null)
                }}
                className={`flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-4 text-left ${selectedKey === item.key ? 'bg-muted' : 'hover:bg-muted/60'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.task.title}</span>
                  <span className="mt-1 block truncate text-xs text-text-muted">
                    {item.projectName} · {new Date(status.updatedAt).toLocaleString()}
                  </span>
                </span>
                <span className="text-sm text-text-secondary">{statusLabel(item)}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
              </button>
            )
          })}
        </div>
      </div>
      {selected && selectedState && (
        <aside
          aria-label={t('standIn.workspace.work_preview')}
          data-testid="stand-in-work-preview"
          className="absolute inset-0 z-10 flex flex-col overflow-y-auto border-l border-border bg-background p-5 md:relative md:inset-auto md:w-96 md:shrink-0"
        >
          <header className="flex items-start gap-3">
            <h2 className="min-w-0 flex-1 font-medium">{selected.task.title}</h2>
            <button
              type="button"
              data-testid="stand-in-preview-close"
              aria-label={t('standIn.close')}
              onClick={() => setSelectedKey(null)}
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <p className="mt-3 text-xs text-text-muted">{selected.projectName}</p>
          <p className="mt-5 whitespace-pre-wrap text-sm" data-testid="stand-in-preview-summary">
            {selectedState.summary ||
              selectedWork?.latestMessage?.text ||
              t('standIn.workspace.preview_no_summary')}
          </p>
          <p className="mt-4 text-sm text-text-secondary">{statusLabel(selected)}</p>
          {active && (!selectedWork || selectedWork.task) && (
            <StandInWorkConfirmation key={selected.key} address={selected.address} />
          )}
          {selectedWork && api && userId !== undefined && deviceId && (
            <StandInWorkMessages
              key={selectedWork.id}
              api={api}
              userId={userId}
              deviceId={deviceId}
              work={selectedWork}
              siblings={inbox}
              onRefresh={() => onRefresh?.()}
            />
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm text-error">
              {error}
            </p>
          )}
          <div className="mt-auto pt-6">
            <p className="mb-3 text-xs text-text-muted">{t('standIn.workspace.preview_help')}</p>
            <button
              type="button"
              data-testid="stand-in-preview-open"
              disabled={
                busy ||
                (!needsStart && (!onOpenTask || (!!selectedWork && !selectedWork.task))) ||
                (!!needsStart && !api)
              }
              onClick={async () => {
                try {
                  setBusy(true)
                  const address =
                    needsStart && api && userId !== undefined && deviceId
                      ? await api.runWork(userId, deviceId, selectedWork.id)
                      : selected.address
                  onRefresh?.()
                  await onOpenTask?.(address)
                } catch (cause) {
                  setError(String(cause))
                } finally {
                  setBusy(false)
                }
              }}
              className="inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-50"
            >
              {t(needsStart ? 'standIn.workspace.start_work' : 'standIn.workspace.open_work')}
              <ArrowUpRight className="h-4 w-4" />
            </button>
          </div>
        </aside>
      )}
    </div>
  )
}
