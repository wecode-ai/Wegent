import { useMemo, useRef, useState } from 'react'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  AlertCircle,
  CheckCheck,
  ChevronRight,
  Clock,
  Minus,
  MessageSquare,
  ShieldCheck,
} from 'lucide-react'
import type {
  MessageCenterCommand,
  MessageCenterRecord,
  MessageCenterSnapshot,
  MessageCenterSource,
} from '@/api/standInMessageCenter'
import { Button } from '@/components/ui/button'
import { OPEN_NOTIFICATION_SETTINGS_EVENT } from '@/features/notifications/notificationPreferences'
import { useTranslation } from '@/hooks/useTranslation'
import { classifyMessageCenterRecords, isToday } from './messageCenterModel'
import { MessageCenterDetail } from './MessageCenterDetail'

type Category = keyof ReturnType<typeof classifyMessageCenterRecords>
type RecordFilter = Exclude<Category, 'in_progress'>
type FocusDestination = 'detail' | 'row'
const filters: RecordFilter[] = ['replied', 'needs_user', 'skipped', 'exceptions']
const icons = {
  replied: CheckCheck,
  needs_user: MessageSquare,
  skipped: Minus,
  exceptions: AlertCircle,
  in_progress: Clock,
}

type Props = {
  snapshot: MessageCenterSnapshot | null
  loading: boolean
  error: boolean
  busy: boolean
  actionError: boolean
  onRefresh(): void
  onCommand(command: MessageCenterCommand): Promise<boolean>
  onOpenSettings(source: MessageCenterSource | undefined, trigger: HTMLElement): void
  onOpenComponents?(): void
}

export function StandInMessageCenter(props: Props) {
  return <MessageCenterContent key={props.snapshot?.identity?.id ?? ''} {...props} />
}

function MessageCenterContent({
  snapshot,
  loading,
  error,
  busy,
  actionError,
  onRefresh,
  onCommand,
  onOpenSettings,
  onOpenComponents,
}: Props) {
  const { t, i18n } = useTranslation('standInMessageCenter')
  const groups = classifyMessageCenterRecords(snapshot?.identity ? snapshot.records : [])
  const [filter, setFilter] = useState<RecordFilter | null>(null)
  const [openedId, setOpenedId] = useState<string>()
  const centerRef = useRef<HTMLElement>(null)
  const rowTrigger = useRef<HTMLElement | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ target: FocusDestination }>()
  const selected =
    filter ?? (groups.exceptions.length || snapshot?.syncGap ? 'exceptions' : 'replied')
  const selectedCategory = [...filters, 'in_progress' as const].find(category =>
    groups[category].some(record => record.id === openedId)
  )
  const record = selectedCategory && groups[selectedCategory].find(item => item.id === openedId)
  const dateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const formatTime = (value: string) => {
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : ''
  }
  const closeRecord = () => {
    setFocusRequest({ target: 'row' })
    setOpenedId(undefined)
  }
  const openRecord = (recordId: string, trigger: HTMLElement) => {
    rowTrigger.current = trigger
    setFocusRequest({ target: 'detail' })
    setOpenedId(recordId)
  }

  const focusTarget = useMemo(
    () => ({
      get current() {
        if (focusRequest?.target === 'detail') {
          return (
            centerRef.current?.querySelector<HTMLElement>(
              '[data-testid="message-center-detail-heading"]'
            ) ?? null
          )
        }
        return rowTrigger.current?.isConnected
          ? rowTrigger.current
          : (centerRef.current?.querySelector<HTMLElement>(
              '[data-testid="message-center-filter"]'
            ) ?? null)
      },
    }),
    [focusRequest]
  )
  useFocusRequest(focusTarget, focusRequest, { enabled: !!focusRequest, preventScroll: true })

  const status = snapshot?.status ?? 'unavailable'
  const todayCount = groups.replied.filter(
    item => item.receipt?.verifiedAt && isToday(item.receipt.verifiedAt)
  ).length
  const hasRecords = Object.values(groups).some(items => items.length > 0)
  const showAttention = selected !== 'needs_user' && groups.needs_user.length > 0
  const includedSources = snapshot?.sources.filter(source => source.included) ?? []
  const delegationAction = snapshot?.capabilities.find(
    capability => capability === 'pause' || capability === 'resume'
  )

  return (
    <section
      ref={centerRef}
      aria-label={t('center')}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-text-primary"
      data-testid="stand-in-message-center"
    >
      <div className="flex min-h-0 flex-1">
        <div
          className={`${record ? 'hidden lg:flex lg:w-1/2' : 'flex'} min-h-0 min-w-0 flex-1 flex-col`}
        >
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 lg:px-5">
            <h1 className="heading-sm min-w-0 break-words">{t('title')}</h1>
            <div className="flex flex-wrap items-center gap-2">
              {delegationAction && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 min-w-11 md:min-h-9"
                  data-testid="message-center-toggle-pause"
                  disabled={busy || loading || error}
                  onClick={() => void onCommand({ type: delegationAction })}
                >
                  {t(delegationAction === 'pause' ? 'pauseDelegation' : 'resumeDelegation')}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 min-w-11 md:min-h-9"
                data-testid="message-center-open-settings"
                onClick={event => onOpenSettings(undefined, event.currentTarget)}
              >
                {t('settings')}
              </Button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="message-center-scroll">
            <div className="mx-auto w-full max-w-3xl space-y-7 px-3 pb-8 pt-5 lg:px-5">
              {(loading || error) && (
                <div className="space-y-3" role={error ? 'alert' : 'status'}>
                  <p className="text-sm">{t(error ? 'loadError' : 'loading')}</p>
                  {error ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 md:min-h-9"
                      data-testid="message-center-retry"
                      onClick={onRefresh}
                    >
                      {t('retry')}
                    </Button>
                  ) : (
                    <div aria-hidden="true" className="space-y-2 motion-safe:animate-pulse">
                      <div className="h-8 w-1/3 rounded-md bg-muted" />
                      <div className="h-16 w-full rounded-md bg-muted" />
                      <div className="h-16 w-full rounded-md bg-muted" />
                    </div>
                  )}
                </div>
              )}
              {snapshot && !error && (
                <>
                  <div className="min-w-0 break-words">
                    <p className="flex items-center gap-2 text-sm" role="status">
                      <span
                        aria-hidden="true"
                        className={`size-1.5 shrink-0 rounded-full ${status === 'active' ? 'bg-emerald-600 dark:bg-emerald-400' : 'bg-text-muted'}`}
                      />
                      {t(`runStatus.${status}`)}
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">
                      {[
                        snapshot.identity?.account,
                        snapshot.identity?.organization,
                        snapshot.deviceName,
                        snapshot.updatedAt && t('updated', { at: formatTime(snapshot.updatedAt) }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  {(status === 'disconnected' || status === 'disabled') && (
                    <Button
                      type="button"
                      className="min-h-11 md:min-h-9"
                      data-testid="message-center-start-setup"
                      onClick={event => onOpenSettings(undefined, event.currentTarget)}
                    >
                      {t(status === 'disabled' ? 'setupRequired' : 'connectionRequired')}
                    </Button>
                  )}
                  {status === 'component_unavailable' && onOpenComponents && (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 md:min-h-9"
                      data-testid="message-center-component-settings"
                      onClick={onOpenComponents}
                    >
                      {t('componentSettings')}
                    </Button>
                  )}
                  {status === 'model_unavailable' && (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 md:min-h-9"
                      data-testid="message-center-model-settings"
                      onClick={event => onOpenSettings(undefined, event.currentTarget)}
                    >
                      {t('manageConnection')}
                    </Button>
                  )}
                  {snapshot.capabilities.includes('refresh') && (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 md:min-h-9"
                      data-testid="message-center-refresh"
                      onClick={onRefresh}
                    >
                      {t('refresh')}
                    </Button>
                  )}
                  {snapshot.identity ? (
                    <>
                      <section className="space-y-2">
                        <p className="text-sm text-text-secondary">{t('today')}</p>
                        <h2 className="heading-lg" data-testid="message-center-replied-today">
                          {t('repliedToday', { count: todayCount })}
                        </h2>
                        {todayCount > 0 && (
                          <p className="text-sm text-text-secondary">{t('confirmedHint')}</p>
                        )}
                      </section>
                      <ControlButton
                        type="button"
                        variant="unstyled"
                        className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-border p-4 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        data-testid="message-center-scope"
                        onClick={event => onOpenSettings(undefined, event.currentTarget)}
                      >
                        <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 break-words">
                          <span className="block font-medium">{t('sourceScope')}</span>
                          <span className="line-clamp-2 text-xs text-text-secondary">
                            {[
                              t('coverage', { count: includedSources.length }),
                              ...includedSources.map(source =>
                                source.paused
                                  ? t('scopeSourcePaused', { name: source.name })
                                  : source.name
                              ),
                            ].join(' · ')}
                          </span>
                        </span>
                        <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
                      </ControlButton>
                      {snapshot.notificationUnavailable && (
                        <div className="space-y-1 border-b border-border pb-3 text-sm text-text-secondary">
                          <p>{t('notificationUnavailable')}</p>
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="min-h-11 px-0 md:min-h-9"
                            data-testid="message-center-notification-settings"
                            onClick={() =>
                              window.dispatchEvent(new Event(OPEN_NOTIFICATION_SETTINGS_EVENT))
                            }
                          >
                            {t('openNotificationSettings')}
                          </Button>
                        </div>
                      )}
                      {showAttention && (
                        <section>
                          <h2 className="flex justify-between gap-2 font-medium">
                            <span>{t('attention')}</span>
                            <span className="text-sm font-normal text-text-secondary">
                              {groups.needs_user.length}
                            </span>
                          </h2>
                          <RecordList
                            records={groups.needs_user}
                            category="needs_user"
                            openedId={openedId}
                            onOpen={openRecord}
                          />
                        </section>
                      )}
                      {groups.in_progress.length > 0 && (
                        <section>
                          <h2 className="font-medium">{t('progress')}</h2>
                          <RecordList
                            records={groups.in_progress}
                            category="in_progress"
                            openedId={openedId}
                            onOpen={openRecord}
                          />
                        </section>
                      )}
                      <section>
                        <header className="flex flex-wrap items-center justify-between gap-2">
                          <h2 className="font-medium">{t('history')}</h2>
                          <div className="flex max-w-full flex-wrap items-center gap-2">
                            {selected !== 'exceptions' &&
                              (groups.exceptions.length > 0 || snapshot.syncGap) && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="min-h-11 md:min-h-9"
                                  data-testid="message-center-show-exceptions"
                                  onClick={() => {
                                    setFilter('exceptions')
                                    setOpenedId(undefined)
                                  }}
                                >
                                  <AlertCircle aria-hidden="true" />
                                  {t('filterOption', {
                                    label: t('recordStatus.exceptions'),
                                    count: groups.exceptions.length,
                                  })}
                                </Button>
                              )}
                            <SelectRoot<RecordFilter>
                              value={selected}
                              onValueChange={value => {
                                if (!value) return
                                setFilter(value)
                                setOpenedId(undefined)
                              }}
                            >
                              <SelectTrigger
                                aria-label={t('filterLabel')}
                                className="min-h-11 max-w-full md:min-h-9"
                                data-testid="message-center-filter"
                              />
                              <SelectContent>
                                {filters.map(category => (
                                  <SelectItem key={category} value={category}>
                                    {t('filterOption', {
                                      label: t(`recordStatus.${category}`),
                                      count: groups[category].length,
                                    })}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </SelectRoot>
                          </div>
                        </header>
                        {snapshot.syncGap && (
                          <p className="mt-3 break-words text-sm text-error">
                            {t('syncGap')} {snapshot.syncGap}
                          </p>
                        )}
                        {groups[selected].length ? (
                          <RecordList
                            records={groups[selected]}
                            category={selected}
                            openedId={openedId}
                            onOpen={openRecord}
                          />
                        ) : (
                          <p
                            className="py-4 text-sm text-text-secondary"
                            data-testid="message-center-empty"
                          >
                            {t(hasRecords ? 'filterEmpty' : 'empty')}
                          </p>
                        )}
                      </section>
                    </>
                  ) : status === 'unavailable' ? null : (
                    <p className="text-sm text-text-secondary" data-testid="message-center-empty">
                      {t('empty')}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        {record && selectedCategory && snapshot && (
          <MessageCenterDetail
            key={record.id}
            record={record}
            category={selectedCategory}
            snapshot={snapshot}
            busy={busy}
            formatTime={formatTime}
            onClose={closeRecord}
            onOpenSettings={onOpenSettings}
            onCommand={onCommand}
          />
        )}
      </div>
      {actionError && (
        <p role="alert" className="border-t border-border p-3 text-sm text-error">
          {t('actionError')}
        </p>
      )}
    </section>
  )
}

function RecordList({
  records,
  category,
  openedId,
  onOpen,
}: {
  records: MessageCenterRecord[]
  category: Category
  openedId?: string
  onOpen(recordId: string, trigger: HTMLElement): void
}) {
  const { t } = useTranslation('standInMessageCenter')
  const Icon = icons[category]
  return (
    <ul className="divide-y divide-border border-b border-border">
      {records.map(record => (
        <li key={record.id} className="min-w-0">
          <ControlButton
            type="button"
            variant="unstyled"
            className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md px-1 py-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
            data-testid={`message-center-record-${record.id}`}
            aria-expanded={openedId === record.id}
            onClick={event => onOpen(record.id, event.currentTarget)}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
              <Icon aria-hidden="true" className="size-4 text-text-secondary" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{record.title}</span>
              <span className="block truncate text-sm text-text-secondary">
                {[record.sender, record.reply || record.message].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span
              className={`max-w-[25%] shrink-0 break-words text-right text-xs ${category === 'replied' ? 'text-emerald-700 dark:text-emerald-400' : 'text-text-secondary'}`}
            >
              {t(
                record.delivery === 'submitted' ||
                  record.delivery === 'unknown' ||
                  record.delivery === 'failed'
                  ? `deliveryStatus.${record.delivery}`
                  : category === 'in_progress'
                    ? `processStatus.${record.progress}`
                    : `recordStatus.${category}`
              )}
              {record.takenOver && <span className="block">{t('takenOver')}</span>}
            </span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
          </ControlButton>
        </li>
      ))}
    </ul>
  )
}
