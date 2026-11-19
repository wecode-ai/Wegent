import { useCallback, useId, useRef, useState, useSyncExternalStore } from 'react'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import { createRuntimeInteractionsPageState } from './runtimeInteractionsPageState'
import { ArrowLeft, ArrowUpRight, RefreshCw, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { NotificationEntitySurface } from './NotificationEntitySurface'
import { openWeworkScheme } from './schemeEvents'
import { weworkIssueScheme, weworkTaskScheme } from './scheme'
import { issueWaitingSince, issueNeedsUser, pendingIssueHumanRequests } from '@wegent/collaboration'
import { IssueWaitingTime } from './IssueWaitingTime'
import { usePendingProjectIssues } from './usePendingProjectIssues'
import { projectIssueAssignedAfter, projectIssueNeedsInput } from './pendingProjectWork'
import {
  issueHumanInteraction,
  issueQuestionIdentity,
  issueQuestionHandoff,
  hasRecordedIssueResolution,
} from './issueHumanInteractions'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  INTERACTION_SOURCES,
  interactionOriginalScheme,
  interactionSource,
} from './runtimeInteractions'
import { cn } from '@/lib/utils'
import { WorkbenchErrorBoundary } from '@/components/common/WorkbenchErrorBoundary'
import { canDiscussQuestion, useQuestionDiscussion } from './questionDiscussion'
import { InteractionTime } from './InteractionTime'
import { InteractionDraftRecovery } from './InteractionDraftRecovery'

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
  dismissalId?: string
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
  const discussion = useQuestionDiscussion()
  const { t } = useTranslation('common')
  const twoPanes = useIsDesktop()
  const owner = useId()
  const list = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [page] = useState(() =>
    createRuntimeInteractionsPageState(selectedId, twoPanes, interactions)
  )
  const projectItemId = ({ item, store }: (typeof projectIssues.items)[number]) =>
    `project-issue:${store}:${item.cloud_project_id}:${item.id}`
  const projectRequests = (row: (typeof projectIssues.items)[number]) =>
    pendingIssueHumanRequests(row.item).filter(request =>
      issueNeedsUser({ ...row.item, human_requests: [request] }, row.userId)
    )
  const projectDismissalId = (row: (typeof projectIssues.items)[number]) => {
    const requests = projectRequests(row)
    const scope = requests.length
      ? ':' +
        JSON.stringify(
          requests.map(request => [request.id, request.waiting_since ?? request.created_at]).sort()
        )
      : ''
    return `${projectItemId(row)}:${issueWaitingSince(row.item, row.userId) ?? 'untracked'}${scope}`
  }
  const projectItems = projectIssues.items.map(row => {
    let handledAt: number | undefined
    const requests = row.item.human_requests?.filter(request => {
      if (request.status !== 'pending' && request.status !== 'answering') return true
      const question = issueHumanInteraction(request, row.store)
      const resolution = interactions?.history.find(entry =>
        hasRecordedIssueResolution(question, [entry])
      )
      if (!resolution) return true
      handledAt = Math.max(handledAt ?? 0, resolution.answeredAt)
      return false
    })
    return {
      ...row,
      item: requests ? { ...row.item, human_requests: requests } : row.item,
      handledAt,
    }
  })
  const projectRows = projectItems.filter(row => {
    if (
      row.handledAt !== undefined &&
      !pendingIssueHumanRequests(row.item).length &&
      (!projectIssueAssignedAfter(row.item, row.userId, row.handledAt) ||
        !projectIssueNeedsInput(row.item, row.userId))
    )
      return false
    if (interactions?.isDismissed?.(projectDismissalId(row))) return false
    const requests = projectRequests(row)
    if (
      requests.length > 0 &&
      requests.every(request => {
        const interaction = issueHumanInteraction(request, row.store)
        return interactions?.isDismissed?.(
          interaction.id,
          issueQuestionIdentity(interaction),
          issueQuestionHandoff(interaction)
        )
      })
    )
      return false
    return !interactions?.pending.some(
      request =>
        request.project?.store === row.store &&
        String(request.project.projectId) === String(row.item.cloud_project_id) &&
        request.project.issueId === row.item.id
    )
  })
  const projectCountKnown =
    active && !projectIssues.loading && !Object.values(projectIssues.errors).some(Boolean)
  const projectCount = projectCountKnown ? projectRows.length : null
  const refreshProjects = projectIssues.refresh
  const view = page.observe({
    owner,
    active,
    selectedId,
    twoPanes,
    interactions,
    projectCount,
    refreshProjects,
  })
  const {
    history,
    selected,
    showList,
    viewed,
    dismissing,
    dismissFailed,
    originalNavigation,
    focusListRequested,
    focusListVersion,
  } = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot)
  const { setSelected, setHistory, setShowList } = page
  const onOriginalUrlChange = useCallback(
    (id: string, url: string) => page.setOriginalNavigation(id, url),
    [page]
  )
  useFocusRequest(heading, JSON.stringify([twoPanes, showList, selected, viewed]), {
    enabled: !twoPanes && !showList,
  })
  useFocusRequest(list, focusListVersion, {
    enabled: !twoPanes && showList && focusListRequested,
    selector: 'button[aria-pressed="true"], :scope:not(:has(button[aria-pressed="true"])) h1',
  })
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
        ...projectRows.map(projectRow => {
          const { item, store, userId } = projectRow
          return {
            id: projectItemId(projectRow),
            dismissalId: projectDismissalId(projectRow),
            source: 'project' as const,
            timestamp: Date.parse(issueWaitingSince(item, userId) ?? item.updated_at),
            title: item.project_name,
            question: item.title,
            originalUrl: weworkIssueScheme(String(item.cloud_project_id), item.id, store),
            waitingSince: issueWaitingSince(item, userId),
            projectItem: true,
          }
        }),
      ]
  const dismissRows = async (entries: PendingWorkRow[]) => {
    if (!page.beginDismiss()) return
    const isCurrent = page.capture()
    try {
      for (const entry of entries) {
        if (!isCurrent()) return
        if (interactions.busy.has(entry.id)) continue
        const request = pending.find(item => item.id === entry.id)
        const projectRow = projectRows.find(item => projectItemId(item) === entry.id)
        const questions = projectRow
          ? projectRequests(projectRow).map(item => issueHumanInteraction(item, projectRow.store))
          : []
        const targets = request
          ? [request]
          : questions.length
            ? questions
            : [
                {
                  id: entry.dismissalId ?? entry.id,
                  source: entry.source,
                  title: entry.title,
                  question: entry.question,
                  originalUrl: entry.originalUrl,
                  answeredAt: Date.now(),
                },
              ]
        let failed = false
        for (const target of targets) {
          if (!isCurrent()) return
          try {
            await interactions.dismiss(target)
          } catch {
            failed = true
            if (isCurrent()) page.failDismiss()
          }
        }
        if (isCurrent() && !failed) setSelected(current => (current === entry.id ? null : current))
      }
    } finally {
      page.finishDismiss()
    }
  }
  const row = selected ? rows.find(item => item.id === selected) : rows[0]
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
          <h1 tabIndex={-1} className="min-w-0 flex-1 text-base font-medium outline-none">
            {t(history ? 'interactions.history' : 'interactions.title')}{' '}
            <span
              data-testid={history ? 'interactions-history-count' : 'interactions-pending-count'}
              className="ml-1 text-sm text-text-secondary"
            >
              {history ? interactions.history.length : pending.length + projectRows.length}
            </span>
          </h1>
          {!history && (
            <button
              type="button"
              data-testid="interactions-dismiss-all"
              disabled={dismissing || !rows.length || interactions.busy.size > 0}
              className="min-h-11 shrink-0 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50 md:min-h-8"
              onClick={() => void dismissRows(rows)}
            >
              {t('interactions.dismiss_all')}
            </button>
          )}
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
          <InteractionDraftRecovery />
          {dismissFailed && (
            <p role="alert" className="px-3 py-2 text-sm text-status-error">
              {t('interactions.dismiss_failed')}
            </p>
          )}
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
                    {!history && (
                      <button
                        type="button"
                        data-testid="interaction-dismiss"
                        aria-label={t('interactions.skip')}
                        title={t('interactions.skip')}
                        disabled={dismissing || interactions.busy.has(entry.id)}
                        className="absolute right-1 top-2 flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50 md:h-7 md:w-7 keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus"
                        onClick={() => void dismissRows([entry])}
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
            .filter(
              ([key]) =>
                !pending.some(request => request.id === key) &&
                !interactions.history.some(item => item.id === key) &&
                !interactions.replyDrafts.some(draft => draft.interaction.id === key)
            )
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
              page.returnToList()
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
