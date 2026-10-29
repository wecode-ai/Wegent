import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useStandInOpened } from '@/telemetry/useStandInOpened'
import { ArrowUpRight, ChevronRight, GripVertical, Layers, Split, X } from 'lucide-react'
import { useState } from 'react'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import type { StandInExecutorApi, StandInInboxWork } from '@/api/standIn'
import { StandInWorkMessages } from './StandInWorkMessages'
import { useRuntimeInteractions } from '@/features/notifications/RuntimeInteractionsContext'
import { useStandInWorkOrganization } from './useStandInWorkOrganization'
import { inboxRuntimeItem } from './useStandInInbox'

type WorkFilter = 'all' | 'running' | 'completed'

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
  const interactions = useRuntimeInteractions()
  const [filter, setFilter] = useState<WorkFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expandedWorkId, setExpandedWorkId] = useState<string | null>(null)
  const organization = useStandInWorkOrganization({
    api,
    userId,
    deviceId,
    onRefresh,
    onSelect: work => {
      if (deviceId) setSelectedKey(inboxRuntimeItem(work, deviceId).key)
    },
  })
  const selected = items.find(item => item.key === selectedKey)
  const selectedState = selected && standInState(selected)
  const selectedWork = inbox.find(work => work.taskId === selected?.task.taskId)
  const selectedOrigin = selected?.task.runtimeHandle?.origin as
    | { standInId?: string | null }
    | undefined
  const identity =
    (selectedWork?.roleId ?? selectedOrigin?.standInId) === '@primary' ? 'primary' : 'role'
  useStandInOpened('work', identity, active && !!selected, selected?.key)
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
  const available = items.filter(
    item => !inbox.some(work => work.taskId === item.task.taskId && work.messageCount === 0)
  )
  const history = items.filter(item =>
    inbox.some(work => work.taskId === item.task.taskId && work.messageCount === 0 && !!work.task)
  )
  const visible = available.filter(item => filter === 'all' || filterStatus(item) === filter)
  return (
    <div className="flex min-h-0 flex-1" data-testid="stand-in-activity">
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        <nav aria-label={t('standIn.workspace.work_filters')} className="mb-4 flex flex-wrap gap-1">
          {(['all', 'running', 'completed'] as const).map(value => (
            <button
              key={value}
              type="button"
              data-testid={`stand-in-filter-${value}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`min-h-11 md:min-h-8 rounded-md px-3 text-sm ${filter === value ? 'bg-muted font-medium' : 'text-text-muted hover:bg-muted'}`}
            >
              {t(`standIn.workspace.filter_${value}`)}
            </button>
          ))}
        </nav>
        {organization.choosing && (
          <div
            className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-muted p-3 text-sm"
            role="status"
            data-testid="stand-in-choose-merge-target"
          >
            <span>
              {t(
                organization.drag?.messageIds
                  ? 'standIn.workspace.choose_message_target'
                  : 'standIn.workspace.choose_merge_target'
              )}
            </span>
            <button
              type="button"
              data-testid="stand-in-organize-cancel"
              onClick={organization.cancel}
              className="min-h-11 md:min-h-9 rounded-md px-2 hover:bg-background"
            >
              {t('standIn.cancel')}
            </button>
          </div>
        )}
        {organization.undo && (
          <div
            className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-muted p-3 text-sm"
            role="status"
            data-testid="stand-in-organization-done"
          >
            <span>
              {t(`standIn.workspace.work_${organization.undo.kind}`, {
                count: organization.undo.ids.length,
              })}
            </span>
            <button
              type="button"
              disabled={organization.busy}
              data-testid="stand-in-organization-undo"
              onClick={() => void organization.undoOrganization()}
              className="min-h-11 md:min-h-9 rounded-md px-2 font-medium hover:bg-background"
            >
              {t('standIn.workspace.undo_organization')}
            </button>
          </div>
        )}
        {organization.error && (
          <p role="alert" className="mb-3 text-sm text-error">
            {organization.error}
          </p>
        )}
        {!visible.length && (
          <p className="py-8 text-sm text-text-muted">
            {t(
              items.length
                ? 'standIn.workspace.no_matching_work'
                : 'standIn.personal.activity_empty'
            )}
          </p>
        )}
        <div className="space-y-2" data-testid="stand-in-activity-project">
          {visible.map(item => {
            const status = standInState(item)
            const work = inbox.find(work => work.taskId === item.task.taskId)
            const canOrganize =
              !!api &&
              userId !== undefined &&
              !!deviceId &&
              !!work &&
              !organization.busy &&
              (!work.task || status.status !== 'running') &&
              work.status !== 'sending'
            const canDrop =
              canOrganize &&
              !!organization.drag &&
              organization.drag.workId !== work.id &&
              organization.drag.roleId === work.roleId
            return (
              <button
                key={item.key}
                type="button"
                data-testid={`stand-in-activity-task-${item.task.taskId}`}
                aria-pressed={selectedKey === item.key}
                aria-disabled={organization.choosing && !canDrop}
                draggable={canOrganize}
                onDragStart={event => {
                  if (!work || !canOrganize) {
                    event.preventDefault()
                    return
                  }
                  const payload = { workId: work.id, roleId: work.roleId, title: work.title }
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('application/x-wework-work', JSON.stringify(payload))
                  organization.setDrag(payload)
                }}
                onDragEnd={organization.cancel}
                onDragOver={event => {
                  if (canDrop) {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    organization.setHover(work.id)
                  }
                }}
                onDragLeave={() => {
                  if (organization.hover === work?.id) organization.setHover(null)
                }}
                onDrop={event => {
                  if (canDrop && organization.drag) {
                    event.preventDefault()
                    void organization.organize(organization.drag, work)
                  }
                }}
                onClick={() => {
                  if (organization.choosing) {
                    if (canDrop && organization.drag)
                      void organization.organize(organization.drag, work)
                    return
                  }
                  setSelectedKey(item.key)
                  setError(null)
                }}
                className={`group relative flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-4 text-left transition-colors motion-reduce:transition-none ${organization.hover === work?.id && canDrop ? 'border-text-primary bg-muted ring-1 ring-text-primary' : 'border-border'} ${selectedKey === item.key ? 'bg-muted' : 'hover:bg-muted/60'} ${organization.drag && organization.drag.workId === work?.id && !organization.choosing ? 'opacity-40' : ''}`}
              >
                {canOrganize && (
                  <GripVertical
                    className="h-4 w-4 shrink-0 text-text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.task.title}</span>
                  <span className="mt-1 block truncate text-xs text-text-muted">
                    {item.projectName} · {new Date(status.updatedAt).toLocaleString()}
                  </span>
                  {work && work.messageCount > 1 && (
                    <span className="mt-2 inline-flex items-center gap-1 text-xs text-text-muted">
                      <Layers className="h-3.5 w-3.5" />
                      {t('standIn.workspace.work_message_count', { count: work.messageCount })}
                    </span>
                  )}
                  {canDrop && (organization.hover === work.id || organization.choosing) && (
                    <span className="mt-2 block text-xs font-medium">
                      {t(
                        organization.choosing
                          ? organization.drag?.messageIds
                            ? 'standIn.workspace.move_into_here'
                            : 'standIn.workspace.merge_into_here'
                          : organization.drag?.messageIds
                            ? 'standIn.workspace.drop_message_here'
                            : 'standIn.workspace.drop_merge_here'
                      )}
                    </span>
                  )}
                </span>
                <span className="text-sm text-text-secondary">{statusLabel(item)}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
              </button>
            )
          })}
        </div>
        {!!history.length && (
          <details
            className="mt-5 border-t border-border pt-3"
            data-testid="stand-in-organized-history"
          >
            <summary
              className="min-h-11 cursor-pointer py-2 text-sm text-text-muted md:min-h-8 md:py-1"
              data-testid="stand-in-organized-history-toggle"
            >
              {t('standIn.workspace.organized_history')}
            </summary>
            <div className="mt-2 space-y-1">
              {history.map(item => (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`stand-in-activity-task-${item.task.taskId}`}
                  onClick={() => {
                    setSelectedKey(item.key)
                    setError(null)
                  }}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-muted md:min-h-9"
                >
                  <span className="min-w-0 truncate">{item.task.title}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                </button>
              ))}
            </div>
          </details>
        )}
        {((organization.drag?.messageIds && organization.drag.canSplit !== false) ||
          (!organization.drag &&
            expandedWorkId === selectedWork?.id &&
            selectedWork &&
            selectedWork.messageCount > 1)) &&
          !organization.choosing && (
            <div
              data-testid="stand-in-split-dropzone"
              onDragOver={event => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                organization.setHover('__split')
              }}
              onDragLeave={() => {
                if (organization.hover === '__split') organization.setHover(null)
              }}
              onDrop={event => {
                event.preventDefault()
                if (organization.drag) void organization.organize(organization.drag)
              }}
              className={`mt-4 flex min-h-28 items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-sm ${organization.hover === '__split' ? 'border-text-primary bg-muted text-text-primary' : 'border-text-muted bg-muted/40 text-text-muted'}`}
            >
              <Split className="h-4 w-4" />
              {t('standIn.workspace.drop_split_here')}
            </div>
          )}
      </div>
      {selected && selectedState && (
        <aside
          aria-label={t('standIn.workspace.work_preview')}
          data-testid="stand-in-work-preview"
          className={`absolute inset-0 z-10 ${organization.choosing ? 'hidden md:flex' : 'flex'} flex-col overflow-y-auto border-l border-border bg-background p-5 md:relative md:inset-auto md:w-96 md:shrink-0`}
        >
          <header className="flex items-start gap-3">
            <h2 className="min-w-0 flex-1 font-medium">{selected.task.title}</h2>
            <button
              type="button"
              data-testid="stand-in-preview-close"
              aria-label={t('standIn.close')}
              onClick={() => setSelectedKey(null)}
              className="flex h-11 w-11 md:h-8 md:w-8 items-center justify-center rounded-md hover:bg-muted"
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
          {selectedWork && selectedWork.messageCount > 0 && api && (
            <div className="mt-4 flex flex-wrap gap-2">
              {inbox.some(
                work =>
                  work.id !== selectedWork.id &&
                  work.roleId === selectedWork.roleId &&
                  work.messageCount > 0
              ) && (
                <button
                  type="button"
                  data-testid="stand-in-work-merge"
                  disabled={
                    organization.busy ||
                    (!!selectedWork.task && selectedState.status === 'running') ||
                    selectedWork.status === 'sending'
                  }
                  onClick={() => {
                    organization.setDrag({
                      workId: selectedWork.id,
                      roleId: selectedWork.roleId,
                      title: selectedWork.title,
                    })
                    organization.setChoosing(true)
                  }}
                  className="inline-flex min-h-11 md:min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Layers className="h-4 w-4" />
                  {t('standIn.workspace.merge_work')}
                </button>
              )}
              {selectedWork.messageCount > 1 && (
                <button
                  type="button"
                  data-testid="stand-in-work-split"
                  onClick={() => setExpandedWorkId(selectedWork.id)}
                  className="inline-flex min-h-11 md:min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-muted"
                >
                  <Split className="h-4 w-4" />
                  {t('standIn.workspace.split_work')}
                </button>
              )}
            </div>
          )}
          {selectedState.status === 'waiting' && interactions && (
            <button
              type="button"
              data-testid="stand-in-work-open-pending"
              className="mt-5 rounded-lg bg-text-primary px-3 py-2 text-sm text-background"
              onClick={() =>
                interactions.open(
                  interactions.pending.find(item => item.task.key === selected.key)?.id
                )
              }
            >
              {t('interactions.title')}
            </button>
          )}
          {selectedWork && api && userId !== undefined && deviceId && (
            <StandInWorkMessages
              key={selectedWork.id}
              api={api}
              userId={userId}
              deviceId={deviceId}
              work={selectedWork}
              siblings={inbox}
              busy={
                organization.busy ||
                (!!selectedWork.task && selectedState.status === 'running') ||
                selectedWork.status === 'sending'
              }
              expanded={expandedWorkId === selectedWork.id}
              onExpandedChange={open => setExpandedWorkId(open ? selectedWork.id : null)}
              draggedMessageId={
                organization.choosing ? undefined : organization.drag?.messageIds?.[0]
              }
              onDrag={organization.setDrag}
              onDragEnd={organization.cancel}
              onChooseTarget={value => {
                organization.setDrag(value)
                organization.setChoosing(true)
              }}
              onOrganize={value => organization.organize(value)}
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
                  setError(getStandInErrorMessage(cause))
                } finally {
                  setBusy(false)
                }
              }}
              className="inline-flex min-h-11 md:min-h-9 w-full items-center justify-center gap-2 rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-50"
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
