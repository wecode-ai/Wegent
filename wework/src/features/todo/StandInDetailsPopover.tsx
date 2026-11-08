import { useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Clock,
  CircleAlert,
  Monitor,
  HelpCircle,
  Settings,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type { AutomationApi } from '@/features/workbench/workbenchServices'
import type { Automation } from '@/types/automation'
import { formatScheduleSummary } from '@/features/automations/formatScheduleSummary'
import { useStandInProfileSchedules } from './useStandInProfileData'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import type { StandInInboxWork, StandInSourceError } from '@/api/standIn'
import { AnchorPopover } from './AnchorPopover'

export function StandInDetailsPopover({
  anchor,
  name,
  enabled,
  device,
  conversation,
  items,
  inbox,
  sourceErrors,
  error,
  onClose,
  onSettings,
  onGuide,
  onAllActivity,
  renderActivity,
  onStatus,
  onProposal,
  onOpenTask,
  automationApi,
  userId,
  roleId,
  onSchedule,
  suspended = false,
}: {
  anchor: HTMLElement
  name: string
  enabled: boolean
  device?: DeviceInfo
  conversation?: RuntimeTaskAddress
  items: RuntimeTaskReminderItem[]
  inbox: StandInInboxWork[]
  sourceErrors: StandInSourceError[]
  error?: string | null
  onClose(): void
  onSettings(): void
  onGuide?: () => void
  onAllActivity?: () => void
  renderActivity?: (item: RuntimeTaskReminderItem) => ReactNode
  onStatus(): void
  onProposal?: () => void
  onOpenTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  automationApi?: AutomationApi
  userId: number
  roleId?: string
  onSchedule?: (schedule: Automation, trigger: HTMLButtonElement) => void
  suspended?: boolean
}) {
  const { t, i18n } = useTranslation('common')
  const [selected, setSelected] = useState<RuntimeTaskReminderItem | null>(null)
  const [visibleCount, setVisibleCount] = useState(4)
  const [identityHeight, setIdentityHeight] = useState<number | null>(null)
  const identityRef = useRef<HTMLDivElement | null>(null)
  const compact = identityHeight !== null
  const activityTrigger = useRef<HTMLButtonElement | null>(null)
  const backButton = useRef<HTMLButtonElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const overviewScroll = useRef(0)
  const restoreActivity = () => {
    setSelected(null)
    window.requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = overviewScroll.current
      activityTrigger.current?.focus({ preventScroll: true })
    })
  }
  const schedules = useStandInProfileSchedules(
    automationApi,
    userId,
    roleId ?? '@primary',
    conversation?.deviceId
  )
  const activity = [
    ...items.map(item => ({ kind: 'work' as const, item, at: standInState(item).updatedAt })),
    ...schedules.items.map(item => ({
      kind: 'schedule' as const,
      item,
      at: item.lastRunAt && item.lastRunAt > item.updatedAt ? item.lastRunAt : item.updatedAt,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  const needsAttention = Boolean(error || device?.error || sourceErrors.length)
  const latestActivity = [
    ...items.map(item => standInState(item).updatedAt),
    ...schedules.items.flatMap(item => (item.lastRunAt ? [item.lastRunAt] : [])),
  ]
    .sort()
    .at(-1)
  const activityTime = latestActivity ? new Date(latestActivity) : undefined
  const identityStatus =
    activityTime && Number.isFinite(activityTime.getTime())
      ? t('standIn.workspace.details_last_active', {
          time: new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(
            activityTime
          ),
        })
      : t(enabled ? 'standIn.workspace.receiving' : 'standIn.workspace.paused')
  const rowClass =
    'flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-base hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:min-h-9'
  return (
    <AnchorPopover
      anchor={anchor}
      title={t('standIn.workspace.details_title')}
      testId="stand-in-details-popover"
      profile
      suspended={suspended}
      bodyRef={bodyRef}
      onBodyScroll={scrollTop => {
        if (!selected) {
          overviewScroll.current = scrollTop
          setIdentityHeight(current =>
            scrollTop <= 1 ? null : (current ?? identityRef.current?.offsetHeight ?? null)
          )
        }
      }}
      onClose={onClose}
      header={
        selected ? (
          <div className="flex h-12 shrink-0 items-center gap-2 px-2">
            <button
              ref={backButton}
              type="button"
              data-testid="stand-in-details-back"
              aria-label={t('standIn.workspace.back')}
              onClick={restoreActivity}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:h-8 md:w-8"
            >
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            </button>
            <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{selected.task.title}</h2>
          </div>
        ) : undefined
      }
    >
      {selected && renderActivity && (
        <div
          data-testid="stand-in-details-activity"
          className="flex h-[min(520px,65vh)] min-h-0 flex-col"
        >
          {renderActivity(selected)}
          {onOpenTask && (
            <div className="shrink-0 px-4 pb-3 pt-2">
              <button
                type="button"
                data-testid="stand-in-details-open-task"
                onClick={() => {
                  onClose()
                  void onOpenTask(selected.address)
                }}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-text-primary px-3 text-sm text-background md:min-h-9"
              >
                <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
                {t('standIn.workspace.details_open_conversation')}
              </button>
            </div>
          )}
        </div>
      )}
      <div hidden={!!selected}>
        <div
          className="pointer-events-none sticky top-0 z-10"
          style={{ height: identityHeight ?? undefined }}
        >
          <div
            ref={identityRef}
            data-testid="stand-in-details-identity"
            className={`pointer-events-auto flex items-center gap-3 bg-popover px-4 ${compact ? 'h-12' : 'pb-2 pt-4'}`}
          >
            <div className="min-w-0 flex-1">
              <h2 className={`truncate font-medium ${compact ? 'text-base' : 'text-lg'}`}>
                {name}
              </h2>
              <p className="mt-1 text-sm text-text-muted">{identityStatus}</p>
            </div>
            {onGuide && (
              <button
                type="button"
                data-testid="stand-in-guide-open"
                aria-label={t('standIn.onboarding.guide')}
                title={t('standIn.onboarding.guide')}
                onClick={onGuide}
                className="flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-md text-text-muted hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HelpCircle aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <div className="space-y-5 px-4 pb-4 pt-4">
          <section aria-label={t('standIn.workspace.details_device')}>
            <h3 className="mb-2 text-sm font-medium text-text-secondary">
              {t('standIn.workspace.details_device')}
            </h3>
            <div className="flex items-center gap-3 py-2">
              <span className="relative shrink-0">
                <Monitor aria-hidden="true" className="h-4 w-4 text-text-muted" />
                {device?.status === 'online' && (
                  <span className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-success ring-1 ring-popover" />
                )}
              </span>
              <div className="min-w-0">
                <p className="truncate text-base">
                  {device?.name || t('standIn.workspace.details_device_unknown')}
                </p>
                {device && (
                  <p className="mt-0.5 text-sm text-text-muted">
                    {t(`standIn.workspace.details_device_${device?.status ?? 'unknown'}`)}
                  </p>
                )}
              </div>
            </div>
            {needsAttention && (
              <button
                type="button"
                data-testid="stand-in-status-open"
                aria-label={t('standIn.workspace.status_details')}
                onClick={onStatus}
                className={rowClass}
              >
                <CircleAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                <span role="status" className="min-w-0 flex-1 text-sm text-text-secondary">
                  {t('standIn.workspace.details_attention')}
                </span>
                <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
              </button>
            )}
          </section>
          {onProposal && (
            <button
              type="button"
              data-testid="stand-in-proposal-open"
              onClick={onProposal}
              className={rowClass}
            >
              {t('standIn.workspace.pending_configuration')}
              <ArrowUpRight aria-hidden="true" className="ml-auto h-4 w-4" />
            </button>
          )}
          <section aria-label={t('standIn.workspace.details_activity')}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-text-secondary">
                {t('standIn.workspace.details_activity')}
              </h3>
              {onAllActivity && (
                <button
                  type="button"
                  data-testid="stand-in-role-chat"
                  aria-label={t('standIn.workspace.details_all_activity')}
                  title={t('standIn.workspace.details_all_activity')}
                  onClick={onAllActivity}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted"
                >
                  <ChevronRight aria-hidden="true" className="h-4 w-4" />
                </button>
              )}
            </div>
            {!activity.length && !schedules.loading && !schedules.error && (
              <p className="py-2 text-sm text-text-muted">
                {t('standIn.workspace.details_activity_empty')}
              </p>
            )}
            {activity.slice(0, visibleCount).map(entry => {
              if (entry.kind === 'schedule')
                return (
                  <button
                    key={`schedule:${entry.item.id}`}
                    type="button"
                    data-testid={`stand-in-details-schedule-${entry.item.id}`}
                    disabled={!onSchedule}
                    onClick={event => onSchedule?.(entry.item, event.currentTarget)}
                    className={rowClass}
                  >
                    <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{entry.item.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-text-secondary">
                        {entry.item.enabled
                          ? formatScheduleSummary(
                              entry.item.schedule,
                              i18n.language,
                              t,
                              entry.item.timezone
                            )
                          : t('todo.automation_status_paused')}
                      </span>
                    </span>
                    <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                  </button>
                )
              const item = entry.item
              const state = standInState(item)
              const work = inbox.find(work => work.taskId === item.task.taskId)
              const status =
                work && work.status !== 'sent'
                  ? t(`standIn.workspace.inbox_${work.status}`)
                  : t(`standIn.personal.activity_${state.status}`)
              return (
                <div key={item.key}>
                  <button
                    type="button"
                    data-testid={`stand-in-details-task-${item.task.taskId}`}
                    disabled={!renderActivity}
                    onClick={event => {
                      activityTrigger.current = event.currentTarget
                      setSelected(item)
                      window.requestAnimationFrame(() => {
                        if (bodyRef.current) bodyRef.current.scrollTop = 0
                        backButton.current?.focus()
                      })
                    }}
                    className={rowClass}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate leading-5">{item.task.title}</span>
                      <span className="block truncate text-xs leading-4 text-text-muted">
                        {[
                          item.projectName !== item.task.title &&
                          item.projectName !== item.task.taskId
                            ? item.projectName
                            : null,
                          status,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                  </button>
                </div>
              )
            })}
            {schedules.loading && (
              <p role="status" className="py-2 text-sm text-text-muted">
                {t('standIn.loading')}
              </p>
            )}
            {schedules.error && (
              <div role="alert" className="py-2 text-xs text-error">
                {schedules.error}
                <button
                  type="button"
                  data-testid="stand-in-details-schedules-retry"
                  onClick={schedules.retry}
                  className="ml-2 min-h-8 underline"
                >
                  {t('standIn.reload')}
                </button>
              </div>
            )}
            {activity.length > visibleCount && (
              <button
                type="button"
                data-testid="stand-in-details-more"
                onClick={() => setVisibleCount(count => count + 4)}
                className="min-h-11 px-2 text-sm text-text-secondary hover:text-text-primary md:min-h-8"
              >
                {t('standIn.workspace.details_more_activity')}
              </button>
            )}
          </section>
          <div className="border-t border-border pt-2">
            <button
              type="button"
              data-testid="stand-in-settings-open"
              onClick={onSettings}
              className={rowClass}
            >
              <Settings aria-hidden="true" className="h-4 w-4" />
              {t('standIn.workspace.details_manage')}
            </button>
          </div>
        </div>
      </div>
    </AnchorPopover>
  )
}
