import { WorkbenchErrorBoundary } from '@/components/common/WorkbenchErrorBoundary'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { useTranslation } from '@/hooks/useTranslation'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { cn } from '@/lib/utils'
import type { RuntimeTaskAddress } from '@/types/api'
import { issueNeedsUser, issueWaitingSince, pendingIssueHumanRequests } from '@wegent/collaboration'
import {
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '@wegent/collaboration/controls/Collapsible'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ArrowLeft, ArrowUpRight, RefreshCw, X } from 'lucide-react'
import { memo, useCallback, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { InteractionDraftRecovery } from './InteractionDraftRecovery'
import { InteractionTime } from './InteractionTime'
import { RuntimeInteractionReply } from './RuntimeInteractionReply'
import {
  hasRecordedIssueResolution,
  issueHumanInteraction,
  issueQuestionHandoff,
  issueQuestionIdentity,
} from './issueHumanInteractions'
import { IssueWaitingTime } from './IssueWaitingTime'
import { NotificationEntitySurface } from './NotificationEntitySurface'
import { projectIssueAssignedAfter, projectIssueNeedsInput } from './pendingProjectWork'
import { canDiscussQuestion, useQuestionDiscussion } from './questionDiscussion'
import {
  INTERACTION_SOURCES,
  canReplyToInteraction,
  interactionOriginalScheme,
  interactionSource,
} from './runtimeInteractions'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { createRuntimeInteractionsPageState } from './runtimeInteractionsPageState'
import { weworkIssueScheme, weworkTaskScheme } from './scheme'
import { openWeworkScheme } from './schemeEvents'
import { usePendingProjectIssues } from './usePendingProjectIssues'

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

const PendingWorkListRow = memo(function PendingWorkListRow({
  id,
  source,
  timestamp,
  title,
  question,
  waitingSince,
  projectItem,
  history,
  selected,
  dismissLabel,
  dismissDisabled,
  onSelect,
  onDismiss,
}: Pick<
  PendingWorkRow,
  'id' | 'source' | 'timestamp' | 'title' | 'question' | 'waitingSince' | 'projectItem'
> & {
  history: boolean
  selected: boolean
  dismissLabel: string
  dismissDisabled: boolean
  onSelect: (id: string) => void
  onDismiss: (id: string) => void
}) {
  return (
    <div className="group relative">
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="interaction-list-item"
        data-project-issue={projectItem ? 'true' : undefined}
        data-interaction-id={id}
        aria-pressed={selected}
        className={cn(
          'mb-0.5 flex w-full items-start rounded-md px-2.5 py-1.5 text-left text-text-primary hover:bg-[rgb(var(--color-sidebar-hover))] keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus',
          !history && 'pr-12 md:pr-9',
          selected && 'bg-[rgb(var(--color-sidebar-active))]'
        )}
        onClick={() => onSelect(id)}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="truncate text-base" title={projectItem ? question : title}>
              {projectItem ? question : title || question}
            </span>
            <span className="shrink-0 tabular-nums">
              <InteractionTime timestamp={timestamp} testId="interaction-list-time" />
            </span>
          </span>
          {title && question && title !== question && (
            <span
              data-testid="interaction-list-summary"
              className="block truncate text-xs text-text-secondary"
              title={projectItem ? title : question}
            >
              {projectItem ? title : question}
            </span>
          )}
          {!history && source === 'project' && waitingSince && (
            <IssueWaitingTime since={waitingSince} />
          )}
        </span>
      </ControlButton>
      {!history && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="interaction-dismiss"
          aria-label={dismissLabel}
          title={dismissLabel}
          disabled={dismissDisabled}
          className="absolute right-1 top-1.5 flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50 md:h-7 md:w-7 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus"
          onClick={() => onDismiss(id)}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </ControlButton>
      )}
    </div>
  )
})

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
  const detailFocus = useRef<HTMLElement>(null)
  const [contextRowId, setContextRowId] = useState<string | null>(null)
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
  useFocusRequest(detailFocus, JSON.stringify([twoPanes, showList, selected, viewed]), {
    enabled: !twoPanes && !showList,
  })
  useFocusRequest(list, focusListVersion, {
    enabled: !twoPanes && showList && focusListRequested,
    selector: 'button[aria-pressed="true"], :scope:not(:has(button[aria-pressed="true"])) h2',
  })
  const pending = interactions?.pending ?? []
  const loading = interactions?.loading || projectIssues.loading
  const rows: PendingWorkRow[] = history
    ? (interactions?.history ?? []).map(item => ({
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
    if (!interactions || !page.beginDismiss()) return
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
  const selectRow = useCallback(
    (id: string) => {
      setSelected(id)
      setContextRowId(null)
      setShowList(false)
    },
    [setSelected, setShowList]
  )
  const dismissRow = useStableEvent((id: string) => {
    const entry = rows.find(item => item.id === id)
    if (entry) void dismissRows([entry])
  })
  const dismissLabel = t('interactions.skip')
  const row = selected ? rows.find(item => item.id === selected) : rows[0]
  const pendingQuestion = row ? pending.find(item => item.id === row.id) : undefined
  const liveQuestion = pendingQuestion?.cached ? undefined : pendingQuestion
  const quickReply = liveQuestion && canReplyToInteraction(liveQuestion) ? liveQuestion : null
  const approval =
    (liveQuestion?.payload.interactionKind ?? liveQuestion?.payload.interaction_kind) === 'approval'
  const showProcessing = Boolean(
    pendingQuestion && !pendingQuestion.project && !history && !approval
  )
  const showContext = Boolean(row && (contextRowId === row.id || !showProcessing))
  const projectPreview = Boolean(row?.projectItem && showContext)
  const rowUrl = row ? originalUrl(row) : null
  const navigatedUrl = originalNavigation?.id === row?.id ? originalNavigation?.url : undefined
  const openOriginal = useMemo(
    () =>
      rowUrl !== null && (
        <ControlButton
          variant="ghost"
          size="sm"
          type="button"
          data-testid="interaction-open-original"
          className="shrink-0 text-text-secondary"
          onClick={() => openWeworkScheme(navigatedUrl ?? rowUrl)}
        >
          {t('interactions.open_original')}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </ControlButton>
      ),
    [rowUrl, navigatedUrl, t]
  )
  const timestamp = row?.timestamp
  const detailTime = useMemo(
    () =>
      timestamp === undefined ? null : (
        <InteractionTime timestamp={timestamp} testId="interaction-detail-time" />
      ),
    [timestamp]
  )
  const issueHeaderActions = useMemo(
    () =>
      projectPreview && (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2">
          {detailTime}
          {openOriginal}
        </div>
      ),
    [projectPreview, detailTime, openOriginal]
  )
  if (!interactions) return null
  const { errors } = interactions
  return (
    <main
      data-testid="runtime-interactions-page"
      className="flex h-full min-h-0 min-w-0 flex-col bg-background text-text-primary"
    >
      <div className="flex min-h-0 min-w-0 flex-1">
        <section
          ref={list}
          aria-label={t(history ? 'interactions.history' : 'interactions.pending')}
          className={cn(
            'interaction-queue flex min-h-0 w-full shrink-0 flex-col bg-[rgb(var(--color-bg-subtle))]',
            twoPanes && 'w-[clamp(17rem,27%,21rem)] border-r border-border',
            !twoPanes && !showList && 'hidden'
          )}
        >
          <header className="flex shrink-0 items-center justify-between gap-3 px-4 pb-1 pt-3">
            <h1 className="text-heading-sm font-medium">{t('interactions.title')}</h1>
            <ControlButton
              variant="ghost"
              size="icon"
              data-testid="interactions-refresh"
              disabled={loading}
              aria-label={t('notifications.refresh')}
              onClick={() => void Promise.all([interactions.refresh(), projectIssues.refresh()])}
              className="shrink-0 text-text-secondary"
            >
              <RefreshCw aria-hidden="true" className={cn('h-4 w-4', loading && 'animate-spin')} />
            </ControlButton>
          </header>
          <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 px-3 py-1">
            <h2
              tabIndex={-1}
              className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-sm font-medium outline-none"
            >
              {t(history ? 'interactions.history' : 'interactions.pending')}
              <span
                data-testid={history ? 'interactions-history-count' : 'interactions-pending-count'}
                className="tabular-nums text-text-secondary"
              >
                {rows.length}
              </span>
            </h2>
            <ControlButton
              variant="ghost"
              type="button"
              data-testid="interactions-history"
              className="text-text-secondary"
              onClick={() => {
                setHistory(value => !value)
                setSelected(null)
              }}
            >
              {t(history ? 'interactions.pending' : 'interactions.history')}
            </ControlButton>
            {!history && (
              <ControlButton
                variant="ghost"
                type="button"
                data-testid="interactions-dismiss-all"
                disabled={dismissing || !rows.length || interactions.busy.size > 0}
                className="ml-auto text-text-secondary"
                onClick={() => void dismissRows(rows)}
              >
                {t('interactions.dismiss_all')}
              </ControlButton>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
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
                  <h2 className="flex items-center gap-2 px-2.5 pb-1 pt-3 text-xs font-medium text-text-secondary">
                    {t(`interactions.sources.${source}`)}
                    <span data-testid={`interaction-source-count-${source}`}>{entries.length}</span>
                  </h2>
                  {entries.map(entry => (
                    <PendingWorkListRow
                      key={entry.id}
                      id={entry.id}
                      source={entry.source}
                      timestamp={entry.timestamp}
                      title={entry.title}
                      question={entry.question}
                      waitingSince={entry.waitingSince}
                      projectItem={entry.projectItem}
                      history={history}
                      selected={row?.id === entry.id}
                      dismissLabel={dismissLabel}
                      dismissDisabled={dismissing || interactions.busy.has(entry.id)}
                      onSelect={selectRow}
                      onDismiss={dismissRow}
                    />
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
                  <CollapsibleRoot key={store} className="px-3 py-2 text-sm text-status-error">
                    <CollapsibleTrigger
                      data-testid={`project-work-error-${store}`}
                      className="min-h-11 cursor-pointer md:min-h-8"
                    >
                      {t(
                        store.endsWith('local')
                          ? 'issueParticipation.local_load_failed'
                          : 'issueParticipation.cloud_load_failed'
                      )}
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <p className="mt-2 break-words whitespace-pre-wrap">{error}</p>
                    </CollapsiblePanel>
                  </CollapsibleRoot>
                ))}
          </div>
        </section>
        <section
          aria-label={t('interactions.context')}
          className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !twoPanes && showList && 'hidden')}
        >
          {!twoPanes && (
            <ControlButton
              ref={
                projectPreview
                  ? element => {
                      detailFocus.current = element
                    }
                  : undefined
              }
              variant="unstyled"
              type="button"
              data-testid="interactions-back-to-list"
              className="mx-3 mt-2 flex min-h-11 items-center gap-2 self-start rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
              onClick={() => {
                page.returnToList()
              }}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t('interactions.back_to_list')}
            </ControlButton>
          )}
          {row ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {!projectPreview && (
                <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3">
                  <div className="min-w-0 flex-1 basis-52">
                    <h2
                      ref={element => {
                        detailFocus.current = element
                      }}
                      tabIndex={0}
                      data-testid="interaction-question-heading"
                      className="line-clamp-2 break-words text-heading-sm font-medium outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus"
                      title={row.projectItem ? row.question : row.title || row.question}
                    >
                      {row.projectItem ? row.question : row.title || row.question}
                    </h2>
                    {detailTime}
                  </div>
                  {discussion && liveQuestion && canDiscussQuestion(liveQuestion.payload) && (
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      data-testid="interaction-discuss"
                      disabled={interactions.busy.has(liveQuestion.id)}
                      onClick={() =>
                        discussion.open(liveQuestion.task.address, liveQuestion.payload)
                      }
                      className="min-h-11 shrink-0 rounded-md px-2 text-sm text-text-secondary hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus disabled:opacity-50 md:min-h-7"
                    >
                      {t('question_discussion.open')}
                    </ControlButton>
                  )}
                  {openOriginal}
                </header>
              )}
              {showProcessing && (
                <div className="shrink-0 border-b border-border px-5 py-2">
                  <div className="flex items-center gap-1">
                    <ControlButton
                      variant={showContext ? 'ghost' : 'secondary'}
                      size="sm"
                      aria-pressed={!showContext}
                      onClick={() => setContextRowId(null)}
                    >
                      {t('interactions.pending')}
                    </ControlButton>
                    <ControlButton
                      variant={showContext ? 'secondary' : 'ghost'}
                      size="sm"
                      data-testid="interaction-show-context"
                      aria-pressed={showContext}
                      onClick={() => setContextRowId(row.id)}
                    >
                      {t('interactions.context')}
                    </ControlButton>
                  </div>
                </div>
              )}
              {showContext ? (
                <div
                  className={cn(
                    'flex min-h-0 flex-1 flex-col overflow-hidden',
                    projectPreview && 'notification-issue-preview'
                  )}
                  data-testid="interaction-entity-container"
                >
                  <WorkbenchErrorBoundary key={originalUrl(row)}>
                    <NotificationEntitySurface
                      interactionId={row.id}
                      sourceMessageIds={row.sourceMessageIds}
                      focusedRequest={liveQuestion?.payload ?? null}
                      onOriginalUrlChange={onOriginalUrlChange}
                      url={originalUrl(row)}
                      address={row.address}
                      active={active && showContext}
                      issueHeaderActions={issueHeaderActions}
                    />
                  </WorkbenchErrorBoundary>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
                  <div className="mx-auto flex max-w-3xl flex-col gap-5">
                    <p className="whitespace-pre-wrap break-words text-base leading-relaxed">
                      {row.question}
                    </p>
                    {quickReply ? (
                      <RuntimeInteractionReply
                        key={quickReply.id}
                        item={quickReply}
                        autoFocus={false}
                      />
                    ) : (
                      <div className="space-y-3">
                        {pendingQuestion?.cached && (
                          <p className="text-sm text-text-secondary">{t('interactions.cached')}</p>
                        )}
                        <ControlButton
                          variant="primary"
                          type="button"
                          onClick={() => setContextRowId(row.id)}
                        >
                          {t('interactions.context')}
                        </ControlButton>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
              {t(selected ? 'interactions.expired' : 'interactions.empty')}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
