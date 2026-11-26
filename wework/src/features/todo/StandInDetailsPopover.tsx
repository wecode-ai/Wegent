import type { StandInInboxWork, StandInSourceError } from '@/api/standIn'
import { standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Clock,
  HelpCircle,
  LoaderCircle,
  Settings,
} from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { AnchorPopover } from './AnchorPopover'
import type { activeStandInBranchRows } from './standInDelegatedBranches'

const activityStatusIcons = {
  pending: Clock,
  needs_grouping: HelpCircle,
  sending: LoaderCircle,
  running: LoaderCircle,
  waiting: HelpCircle,
  completed: CircleCheck,
  failed: CircleAlert,
  cancelled: CircleMinus,
}

export function StandInDetailsPopover({
  anchor,
  name,
  enabled,
  device,
  items,
  activeDelegations,
  inbox,
  sourceErrors,
  overviewError,
  processingError,
  onClose,
  onSettings,
  onGuide,
  onAllActivity,
  renderActivity,
  onStatus,
  onProposal,
  onOpenTask,
}: {
  anchor: HTMLElement
  name: string
  enabled: boolean
  device?: DeviceInfo
  items: RuntimeTaskReminderItem[]
  activeDelegations: ReturnType<typeof activeStandInBranchRows>
  inbox: StandInInboxWork[]
  sourceErrors: StandInSourceError[]
  overviewError?: string | null
  processingError?: string | null
  onClose(): void
  onSettings(): void
  onGuide?: () => void
  onAllActivity(): void
  renderActivity?: (item: RuntimeTaskReminderItem) => ReactNode
  onStatus(): void
  onProposal?: () => void
  onOpenTask?: (address: RuntimeTaskAddress) => Promise<void> | void
}) {
  const { t, i18n } = useTranslation('common')
  const [selected, setSelected] = useState<RuntimeTaskReminderItem | null>(null)
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
  const threads = items.filter(
    item => !inbox.some(work => work.taskId === item.task.taskId && !work.task)
  )
  const activity = threads
    .map(item => ({ item, state: standInState(item) }))
    .sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt))
  const issues = [
    ...(processingError
      ? [{ label: t('standIn.workspace.details_processing'), message: processingError }]
      : []),
    ...(device?.error
      ? [
          {
            label: device.name || t('standIn.workspace.details_device'),
            message: getStandInErrorMessage(device.error),
          },
        ]
      : []),
    ...sourceErrors.map(({ source, error }) => ({
      label: source.name,
      message: getStandInErrorMessage(error),
    })),
    ...(overviewError
      ? [{ label: t('standIn.workspace.details_title'), message: overviewError }]
      : []),
  ]
  const issue = issues[0]
  const activityDateTime = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const latestActivity = Date.parse(activity[0]?.state.updatedAt ?? '')
  const rowClass =
    'flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-base hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:min-h-9'
  return (
    <AnchorPopover
      anchor={anchor}
      title={t('standIn.workspace.details_title')}
      testId="stand-in-details-popover"
      profile
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
            <ControlButton
              variant="unstyled"
              ref={backButton}
              type="button"
              data-testid="stand-in-details-back"
              aria-label={t('standIn.workspace.back')}
              onClick={restoreActivity}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:h-8 md:w-8"
            >
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            </ControlButton>
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
              <ControlButton
                variant="primary"
                size="sm"
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
              </ControlButton>
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
              <p className="mt-1 text-sm text-text-secondary">
                {t(enabled ? 'standIn.workspace.intake_enabled' : 'standIn.workspace.paused')}
              </p>
              {latestActivity > 0 && !compact && (
                <p className="text-sm text-text-secondary">
                  {t('standIn.workspace.details_last_active', {
                    time: activityDateTime.format(latestActivity),
                  })}
                </p>
              )}
            </div>
            {onGuide && (
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="stand-in-guide-open"
                aria-label={t('standIn.onboarding.guide')}
                title={t('standIn.onboarding.guide')}
                onClick={onGuide}
                className="flex h-11 w-11 shrink-0 items-center justify-center self-start rounded-md text-text-muted hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8 md:w-8"
              >
                <HelpCircle aria-hidden="true" className="h-4 w-4" />
              </ControlButton>
            )}
          </div>
        </div>
        <div className="space-y-3 px-4 pb-2">
          {(issue || onProposal) && (
            <section aria-label={t('standIn.workspace.details_attention')} className="space-y-1">
              {issue && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="stand-in-status-open"
                  title={t('standIn.workspace.status_details')}
                  onClick={onStatus}
                  className={rowClass + ' bg-muted/50 py-2'}
                >
                  <CircleAlert
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 self-start text-warning"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {t('standIn.workspace.status_issues', { count: issues.length })}
                    </span>
                    <span className="block whitespace-normal break-words text-sm text-text-secondary">
                      {issue.label} · {issue.message}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm text-text-secondary">
                    {t('standIn.workspace.details_view')}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
                  />
                </ControlButton>
              )}
              {onProposal && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="stand-in-proposal-open"
                  onClick={onProposal}
                  className={rowClass}
                >
                  {t('standIn.workspace.pending_configuration')}
                  <ArrowUpRight aria-hidden="true" className="ml-auto h-4 w-4" />
                </ControlButton>
              )}
            </section>
          )}
          {activeDelegations.length > 0 && (
            <section
              aria-label={t('standIn.delegation.active')}
              data-testid="stand-in-details-active-delegations"
              className="border-t border-border pt-2"
            >
              <h3 className="mb-1 px-2 text-base font-medium">{t('standIn.delegation.active')}</h3>
              {activeDelegations.map(branch => {
                const address = branch.address
                const content = (
                  <>
                    <Bot aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
                    <span className="min-w-0 flex-1 truncate" title={branch.title}>
                      {branch.title}
                    </span>
                    <span className="max-w-[45%] text-right text-xs text-text-secondary">
                      {t(`standIn.delegation.${branch.status}`)}
                    </span>
                  </>
                )
                return address && onOpenTask ? (
                  <ControlButton
                    key={branch.taskId}
                    variant="unstyled"
                    type="button"
                    data-testid="stand-in-details-open-delegation"
                    className={rowClass}
                    onClick={() => {
                      onClose()
                      void onOpenTask(address)
                    }}
                  >
                    {content}
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
                  </ControlButton>
                ) : (
                  <div key={branch.taskId} className="flex min-h-9 items-center gap-2 px-2 py-1">
                    {content}
                  </div>
                )
              })}
            </section>
          )}
          <section
            aria-label={t('standIn.workspace.details_activity')}
            className="border-t border-border pt-2"
          >
            <div className="mb-1 flex items-center justify-between gap-2 px-2">
              <h3 className="text-base font-medium">{t('standIn.workspace.details_activity')}</h3>
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="stand-in-role-chat"
                onClick={onAllActivity}
                className="min-h-11 shrink-0 rounded-md text-xs text-text-secondary hover:text-text-primary md:min-h-8"
              >
                {t('standIn.workspace.details_all_activity')}
              </ControlButton>
            </div>
            {!activity.length && (
              <p className="px-2 py-2 text-sm text-text-secondary">
                {t('standIn.workspace.details_activity_empty')}
              </p>
            )}
            {activity.slice(0, 3).map(({ item, state }) => {
              const timestamp = Date.parse(state.updatedAt)
              const work = inbox.find(work => work.taskId === item.task.taskId)
              const inboxStatus = work?.status === 'sent' ? undefined : work?.status
              const status = inboxStatus ?? state.status
              const StatusIcon = activityStatusIcons[status]
              const statusLabel = inboxStatus
                ? t(`standIn.workspace.inbox_${inboxStatus}`)
                : t(`standIn.personal.activity_${state.status}`)
              const projectName =
                item.projectName !== item.task.title && item.projectName !== item.task.taskId
                  ? item.projectName
                  : null
              return (
                <ControlButton
                  key={item.key}
                  variant="unstyled"
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
                  <span className="shrink-0" title={statusLabel}>
                    <StatusIcon
                      aria-hidden="true"
                      className={`h-4 w-4 ${status === 'failed' ? 'text-error' : 'text-text-muted'}`}
                    />
                    <span className="sr-only">{statusLabel}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate leading-5">{item.task.title}</span>
                    <span className="flex flex-wrap items-baseline gap-x-2 text-xs leading-4 text-text-secondary">
                      {projectName && <span className="min-w-0 truncate">{projectName}</span>}
                      {timestamp > 0 && (
                        <time className="tabular-nums" dateTime={state.updatedAt}>
                          {activityDateTime.format(timestamp)}
                        </time>
                      )}
                    </span>
                  </span>
                </ControlButton>
              )
            })}
          </section>
          <section className="flex items-center justify-between gap-2 border-t border-border px-2 pt-2">
            <div className="min-w-0">
              <h4 className="text-base font-medium">{t('standIn.workspace.details_device')}</h4>
              <p className="truncate text-xs text-text-secondary">
                {device?.name || t('standIn.workspace.details_device_unknown')}
              </p>
            </div>
            {device && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-text-secondary">
                {device.status === 'online' && (
                  <span className="h-1.5 w-1.5 rounded-full bg-success" />
                )}
                {t(`standIn.workspace.details_device_${device.status}`)}
              </span>
            )}
          </section>
          <div className="border-t border-border pt-2">
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="stand-in-settings-open"
              onClick={onSettings}
              className={rowClass}
            >
              <Settings aria-hidden="true" className="h-4 w-4" />
              {t('standIn.workspace.details_manage')}
            </ControlButton>
          </div>
        </div>
      </div>
    </AnchorPopover>
  )
}
