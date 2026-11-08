import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, RefreshCw, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { NotificationEntitySurface } from './NotificationEntitySurface'
import { openWeworkScheme } from './schemeEvents'
import { weworkIssueScheme, weworkTaskScheme } from './scheme'
import { issueWaitingSince } from '@wegent/collaboration'
import { IssueWaitingTime } from './IssueWaitingTime'
import { usePendingProjectIssues } from './usePendingProjectIssues'
import { issueHumanInteraction } from './issueHumanInteractions'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  INTERACTION_SOURCES,
  interactionOriginalScheme,
  interactionSource,
} from './runtimeInteractions'
import { cn } from '@/lib/utils'
import { WorkbenchErrorBoundary } from '@/components/common/WorkbenchErrorBoundary'
import { canDiscussQuestion, useQuestionDiscussion } from './questionDiscussion'
import { formatNotificationTime } from './notificationTime'

function InteractionTime({ timestamp, testId }: { timestamp: number; testId: string }) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime()) || timestamp <= 0) return null
  return (
    <time
      data-testid={testId}
      className="block text-xs text-text-secondary"
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
    >
      {formatNotificationTime(timestamp)}
    </time>
  )
}

interface PendingWorkRow {
  id: string
  source: ReturnType<typeof interactionSource>
  timestamp: number
  title: string
  question: string
  address?: RuntimeTaskAddress
  originalUrl?: string
  sourceMessageIds?: string[]
  waitingSince?: string | null
  projectItem?: boolean
}

function originalUrl(row: PendingWorkRow): string {
  return row.originalUrl || (row.address ? weworkTaskScheme(row.address) : '')
}

export function RuntimeInteractionsPage({
  selectedId,
  active = true,
}: {
  selectedId?: string | null
  active?: boolean
}) {
  const interactions = useRuntimeInteractions()
  const projectIssues = usePendingProjectIssues(active)
  const refreshInteractions = interactions?.refresh
  useEffect(() => {
    if (active) void refreshInteractions?.()
  }, [active, refreshInteractions])
  const refreshProjectIssues = projectIssues.refresh
  const handoffRevision =
    interactions?.pending
      .filter(item => item.sharedRequest)
      .map(item => `${item.id}:${item.sharedRequest?.version}`)
      .sort()
      .join('|') ?? ''
  const previousHandoffRevision = useRef(handoffRevision)
  useEffect(() => {
    if (!active || previousHandoffRevision.current === handoffRevision) return
    previousHandoffRevision.current = handoffRevision
    void refreshProjectIssues()
  }, [active, handoffRevision, refreshProjectIssues])
  const discussion = useQuestionDiscussion()
  const { t } = useTranslation('common')
  const [history, setHistory] = useState(false)
  const [originalNavigation, setOriginalNavigation] = useState<{ id: string; url: string } | null>(
    null
  )
  const onOriginalUrlChange = useCallback((id: string, url: string) => {
    setOriginalNavigation(current =>
      current?.id === id && current.url === url ? current : { id, url }
    )
  }, [])
  const [selected, setSelected] = useState<string | null>(selectedId ?? null)
  const [showList, setShowList] = useState(!selectedId)
  const twoPanes = useIsDesktop()
  const [lastTwoPanes, setLastTwoPanes] = useState(twoPanes)
  const list = useRef<HTMLElement>(null)
  const listHeading = useRef<HTMLHeadingElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const restoreListFocus = useRef(false)
  const [lastRouteId, setLastRouteId] = useState(selectedId)
  const owner = useId()
  const registerView = interactions?.registerView
  const viewed =
    !history && (twoPanes || !showList)
      ? selected
        ? interactions?.pending.find(item => item.id === selected)?.id
        : interactions?.pending[0]?.id
      : undefined
  useEffect(() => {
    registerView?.(owner, active ? (viewed ?? null) : null)
    return () => registerView?.(owner, null)
  }, [active, owner, registerView, viewed])
  useEffect(() => {
    if (twoPanes) return
    if (!showList) heading.current?.focus()
    else if (restoreListFocus.current) {
      const selectedRow = list.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      const focusTarget = selectedRow ?? listHeading.current
      focusTarget?.focus()
      restoreListFocus.current = false
    }
  }, [twoPanes, showList, selected, viewed])
  if (lastTwoPanes !== twoPanes) {
    setLastTwoPanes(twoPanes)
    // The desktop detail is already open; preserve it when the window becomes narrow.
    if (!twoPanes) setShowList(false)
  }
  if (lastRouteId !== selectedId) {
    setLastRouteId(selectedId)
    setSelected(selectedId ?? null)
    setHistory(false)
    setShowList(!selectedId)
  }
  const projectRows = projectIssues.items.filter(
    row =>
      !row.item.human_requests?.some(
        request =>
          (request.status === 'pending' || request.status === 'answering') &&
          interactions?.history.some(
            accepted => accepted.id === issueHumanInteraction(request, row.store).id
          )
      ) &&
      !interactions?.pending.some(
        request =>
          request.project?.store === row.store &&
          String(request.project.projectId) === String(row.item.cloud_project_id) &&
          request.project.issueId === row.item.id
      )
  )
  const reportProjectPendingCount = interactions?.reportProjectPendingCount
  const projectCountKnown =
    active && !projectIssues.loading && !Object.values(projectIssues.errors).some(Boolean)
  const projectCount = projectCountKnown ? projectRows.length : null
  useEffect(() => {
    reportProjectPendingCount?.(projectCount)
  }, [projectCount, reportProjectPendingCount])
  useEffect(() => () => reportProjectPendingCount?.(null), [reportProjectPendingCount])
  if (!interactions) return null
  const { pending, errors } = interactions
  const loading = interactions.loading || projectIssues.loading
  const rows: PendingWorkRow[] = history
    ? interactions.history.map(item => ({
        ...item,
        source: interactionSource(item),
        timestamp: item.answeredAt,
        waitingSince: undefined as string | undefined,
      }))
    : [
        ...pending.map(item => ({
          id: item.id,
          source: interactionSource(item),
          timestamp: item.createdAt,
          title: item.task.task.title,
          question: item.question,
          address: item.task.address,
          originalUrl: interactionOriginalScheme(item),
          sourceMessageIds: item.sourceMessageIds,
          waitingSince:
            item.sharedRequest?.waiting_since ??
            (item.sharedRequest?.recipient_user_id == null
              ? item.sharedRequest?.created_at
              : undefined),
        })),
        ...projectRows.map(({ item, store, userId }) => ({
          id: `project-issue:${store}:${item.cloud_project_id}:${item.id}`,
          source: 'project' as const,
          timestamp: Date.parse(issueWaitingSince(item, userId) ?? item.updated_at),
          title: item.project_name,
          question: item.title,
          originalUrl: weworkIssueScheme(String(item.cloud_project_id), item.id, store),
          waitingSince: issueWaitingSince(item, userId),
          projectItem: true,
        })),
      ]
  const historical = interactions.history.find(item => item.id === selected)
  const row: PendingWorkRow | undefined = selected
    ? (rows.find(item => item.id === selected) ??
      (historical
        ? { ...historical, source: interactionSource(historical), timestamp: historical.answeredAt }
        : undefined))
    : rows[0]
  const liveQuestion = row ? pending.find(item => item.id === row.id && !item.cached) : undefined
  return (
    <main
      data-testid="runtime-interactions-page"
      className="flex h-full min-h-0 bg-background text-text-primary"
    >
      <section
        ref={list}
        className={cn(
          'flex w-full shrink-0 flex-col border-r border-border bg-muted/20 md:w-64 md:max-w-[36%] xl:w-72',
          !twoPanes && !showList && 'hidden'
        )}
      >
        <header className="flex min-h-14 flex-wrap items-center gap-1 px-4 py-2">
          <h1
            ref={listHeading}
            tabIndex={-1}
            className="min-w-0 flex-1 text-base font-medium outline-none"
          >
            {t(history ? 'interactions.history' : 'interactions.title')}{' '}
            <span
              data-testid={history ? 'interactions-history-count' : 'interactions-pending-count'}
              className="ml-1 text-sm text-text-secondary"
            >
              {history ? interactions.history.length : pending.length + projectRows.length}
            </span>
          </h1>
          <button
            type="button"
            data-testid="interactions-history"
            className="min-h-11 shrink-0 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-8"
            onClick={() => {
              setHistory(value => !value)
              setSelected(null)
            }}
          >
            {t(history ? 'interactions.pending' : 'interactions.history')}
          </button>
          <button
            type="button"
            data-testid="interactions-refresh"
            disabled={loading}
            aria-label={t('notifications.refresh')}
            onClick={() => void Promise.all([interactions.refresh(), projectIssues.refresh()])}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted md:min-h-8 md:min-w-8"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {INTERACTION_SOURCES.map(source => {
            const entries = rows
              .filter(entry => entry.source === source)
              .sort((a, b) => b.timestamp - a.timestamp)
            if (!entries.length) return null
            return (
              <div
                role="group"
                key={source}
                data-testid={`interaction-source-group-${source}`}
                aria-label={t(`interactions.sources.${source}`)}
              >
                <h2 className="flex items-center gap-2 px-3 pb-2 pt-3 text-sm font-medium text-text-secondary">
                  {t(`interactions.sources.${source}`)}
                  <span data-testid={`interaction-source-count-${source}`}>{entries.length}</span>
                </h2>
                {entries.map(entry => (
                  <div key={entry.id} className="group relative">
                    <button
                      type="button"
                      data-testid="interaction-list-item"
                      data-project-issue={entry.projectItem ? 'true' : undefined}
                      data-interaction-id={entry.id}
                      aria-pressed={row?.id === entry.id}
                      className={cn(
                        'mb-1 flex w-full items-start rounded-lg px-3 py-3 text-left hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus',
                        !history && 'pr-12',
                        row?.id === entry.id && 'bg-muted'
                      )}
                      onClick={() => {
                        setSelected(entry.id)
                        setShowList(false)
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          data-testid="interaction-list-summary"
                          className="line-clamp-2 text-base font-medium"
                        >
                          {entry.question}
                        </span>
                        <span
                          className="mt-1 block truncate text-sm text-text-secondary"
                          title={entry.title}
                        >
                          {entry.title}
                        </span>
                        {!history && entry.source === 'project' && (
                          <IssueWaitingTime since={entry.waitingSince ?? null} />
                        )}
                        <InteractionTime
                          timestamp={entry.timestamp}
                          testId="interaction-list-time"
                        />
                      </span>
                    </button>
                    {!history &&
                      !entry.projectItem &&
                      !pending.find(item => item.id === entry.id)?.sharedRequest && (
                        <button
                          type="button"
                          data-testid="interaction-dismiss"
                          aria-label={t('interactions.skip')}
                          title={t('interactions.skip')}
                          disabled={interactions.busy.has(entry.id)}
                          className="absolute right-1 top-2 flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50 md:h-7 md:w-7 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus"
                          onClick={() => {
                            const item = pending.find(item => item.id === entry.id)
                            if (item) void interactions.dismiss(item)
                          }}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                  </div>
                ))}
              </div>
            )
          })}
          {!rows.length && (history || !projectRows.length) && (
            <p
              data-testid={loading ? 'interactions-loading' : 'interactions-empty'}
              className="px-3 py-8 text-sm text-text-secondary"
            >
              {t(loading ? 'interactions.loading' : 'interactions.empty')}
            </p>
          )}
          {Object.entries(errors)
            .filter(([key]) => !pending.some(request => request.id === key))
            .map(([key, error]) => (
              <p key={key} role="alert" className="px-3 py-2 text-sm text-status-error">
                {error}
              </p>
            ))}
          {!history &&
            Object.entries(projectIssues.errors)
              .filter(([, error]) => error)
              .map(([store, error]) => (
                <details key={store} className="px-3 py-2 text-sm text-status-error">
                  <summary
                    data-testid={`project-work-error-${store}`}
                    className="min-h-11 cursor-pointer md:min-h-8"
                  >
                    {t(
                      store.endsWith('local')
                        ? 'issueParticipation.local_load_failed'
                        : 'issueParticipation.cloud_load_failed'
                    )}
                  </summary>
                  <p className="mt-2 break-words whitespace-pre-wrap">{error}</p>
                </details>
              ))}
        </div>
      </section>
      <section
        className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !twoPanes && showList && 'hidden')}
      >
        {!twoPanes && (
          <button
            type="button"
            data-testid="interactions-back-to-list"
            className="mx-3 mt-2 flex min-h-11 items-center gap-2 self-start rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
            onClick={() => {
              restoreListFocus.current = true
              setShowList(true)
            }}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('interactions.back_to_list')}
          </button>
        )}
        {row ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-5 py-2 sm:flex-row sm:items-center sm:gap-3">
              <div className="min-w-0 flex-1">
                <h2
                  ref={heading}
                  tabIndex={0}
                  data-testid="interaction-question-heading"
                  className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-base font-medium outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus"
                >
                  {row.question}
                </h2>
                <p className="mt-1 truncate text-sm text-text-secondary" title={row.title}>
                  {row.title}
                </p>
                <InteractionTime timestamp={row.timestamp} testId="interaction-detail-time" />
              </div>
              {discussion && liveQuestion && canDiscussQuestion(liveQuestion.payload) && (
                <button
                  type="button"
                  data-testid="interaction-discuss"
                  disabled={interactions.busy.has(liveQuestion.id)}
                  onClick={() => discussion.open(liveQuestion.task.address, liveQuestion.payload)}
                  className="min-h-11 shrink-0 rounded-md px-2 text-sm text-text-secondary hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus disabled:opacity-50 md:min-h-7"
                >
                  {t('question_discussion.open')}
                </button>
              )}
              <button
                type="button"
                data-testid="interaction-open-original"
                className="flex min-h-11 shrink-0 self-start items-center gap-1 rounded-md px-2 text-sm text-text-secondary hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus sm:self-auto md:min-h-7"
                onClick={() =>
                  openWeworkScheme(
                    originalNavigation?.id === row.id ? originalNavigation.url : originalUrl(row)
                  )
                }
              >
                {t('interactions.open_original')}
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </header>
            <div
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
              data-testid="interaction-entity-container"
            >
              <WorkbenchErrorBoundary key={originalUrl(row)}>
                <NotificationEntitySurface
                  interactionId={row.id}
                  sourceMessageIds={row.sourceMessageIds}
                  focusedRequest={
                    interactions.pending.find(item => item.id === row.id && !item.cached)
                      ?.payload ?? null
                  }
                  onOriginalUrlChange={onOriginalUrlChange}
                  url={originalUrl(row)}
                  address={row.address}
                  active={active}
                />
              </WorkbenchErrorBoundary>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
            {t(selected ? 'interactions.expired' : 'interactions.empty')}
          </div>
        )}
      </section>
    </main>
  )
}
