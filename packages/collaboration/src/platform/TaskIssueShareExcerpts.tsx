import { selectedShareExcerpts } from './selectedShareExcerpts'
import { Button } from '../markdown/Button'
import { Fragment, useRef, useState } from 'react'
import { useScrollRequest } from '../dom-events'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  Expand,
  Loader2,
  Minus,
  Shrink,
} from 'lucide-react'
import { usePersonalIssueTranslation } from './personalIssueMessages'
import type { TaskIssueShareDraft } from './personalIssuesApi'

export function TaskIssueShareExcerpts({
  excerpts,
  selection,
  shareWholeMessage = false,
  onShareWholeMessage,
  firstAvailable,
  selected,
  onSelect,
  loadEarlier,
}: {
  excerpts: TaskIssueShareDraft['excerpts']
  selection?: TaskIssueShareDraft['selectedExcerpt']
  shareWholeMessage?: boolean
  onShareWholeMessage?(whole: boolean): void
  firstAvailable: boolean
  selected: string[]
  onSelect(ids: string[]): void
  loadEarlier?(): Promise<void>
}) {
  const t = usePersonalIssueTranslation()
  const excerptsRef = useRef<HTMLDivElement>(null)
  useScrollRequest(excerptsRef, '[data-testid="task-issue-share-highlight"]', selection, {
    enabled: Boolean(selection),
    block: 'center',
    animationFrame: true,
  })
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const preview = showAll
    ? excerpts
    : firstAvailable && excerpts.length > 1
      ? [excerpts[0], excerpts[excerpts.length - 1]]
      : excerpts.slice(-1)
  const displayed = selectedShareExcerpts(preview, selection)
  const hasPartialRange = Boolean(
    selection && (selection.start > 0 || selection.end < selection.excerpt.content.length)
  )
  const partial = (id: string) =>
    selection?.excerpt.id === id && hasPartialRange && !shareWholeMessage
  const toggle = (id: string) => {
    if (selected.includes(id) && partial(id)) {
      onShareWholeMessage?.(true)
      return
    }
    if (selection?.excerpt.id === id) onShareWholeMessage?.(false)
    onSelect(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id])
  }
  const allSelected = displayed.every(
    excerpt => selected.includes(excerpt.id) && !partial(excerpt.id)
  )
  async function fetchEarlier() {
    setLoading(true)
    setFailed(false)
    try {
      await loadEarlier?.()
      setShowAll(true)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const expandCached = !showAll && excerpts.length > 2
  const showHistoryGap =
    firstAvailable && displayed.length > 1 && (Boolean(loadEarlier) || expandCached)
  const historyLabel = t(
    loading
      ? 'independentIssues.loading'
      : expandCached
        ? 'taskIssueShare.expandPreview'
        : loadEarlier
          ? 'taskIssueShare.loadEarlier'
          : showAll
            ? 'taskIssueShare.recentExcerpts'
            : 'taskIssueShare.expandPreview'
  )
  const historyAction = (
    <Button
      variant="unstyled"
      showTooltip={false}
      type="button"
      data-testid="task-issue-share-all-excerpts"
      aria-expanded={showAll}
      aria-busy={loading}
      aria-label={showHistoryGap ? historyLabel : undefined}
      title={showHistoryGap ? historyLabel : undefined}
      disabled={loading}
      onClick={() => (loadEarlier && !expandCached ? void fetchEarlier() : setShowAll(!showAll))}
      className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-md px-2 py-1 text-xs text-text-secondary before:flex-1 before:border-t before:border-border after:flex-1 after:border-t after:border-border hover:text-text-primary md:min-h-8 ${showHistoryGap ? 'before:border-dashed after:border-dashed' : ''}`}
    >
      {showHistoryGap ? (
        <span
          className="flex h-6 shrink-0 items-center gap-1 rounded bg-muted px-1.5"
          aria-hidden="true"
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <>
              <Ellipsis className="size-4" />
              {expandCached ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
            </>
          )}
        </span>
      ) : (
        <>
          {historyLabel}
          <ChevronDown
            className={`size-3.5 ${loadEarlier || showAll ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </>
      )}
    </Button>
  )

  return (
    <section
      data-testid="task-issue-share-excerpts"
      aria-label={t('taskIssueShare.excerpts')}
      className="min-w-0"
    >
      <div className="flex flex-wrap gap-x-2">
        <Button
          variant="unstyled"
          showTooltip={false}
          type="button"
          data-testid="task-issue-share-select-all"
          aria-pressed={allSelected}
          disabled={loading || displayed.length === 0}
          onClick={() => {
            const visible = new Set(displayed.map(excerpt => excerpt.id))
            if (selection && visible.has(selection.excerpt.id)) onShareWholeMessage?.(!allSelected)
            onSelect(
              allSelected
                ? selected.filter(id => !visible.has(id))
                : [...new Set([...selected, ...visible])]
            )
          }}
          className="min-h-10 rounded px-2 text-xs text-text-secondary hover:bg-muted md:min-h-7"
        >
          {t('taskIssueShare.selectAll')}
        </Button>
        {excerpts.length > 1 &&
          (firstAvailable ? (['first', 'last'] as const) : (['last'] as const)).map(position => {
            const excerpt = excerpts[position === 'first' ? 0 : excerpts.length - 1]
            return (
              <Button
                variant="unstyled"
                showTooltip={false}
                key={position}
                type="button"
                data-testid={`task-issue-share-select-${position}`}
                aria-pressed={selected.includes(excerpt.id)}
                onClick={() => {
                  toggle(excerpt.id)
                }}
                className="min-h-10 rounded px-2 text-xs text-text-secondary hover:bg-muted md:min-h-7"
              >
                {t(`taskIssueShare.select_${position}`)}
              </Button>
            )
          })}
      </div>
      <div
        ref={excerptsRef}
        data-testid="task-issue-share-message-list"
        className="grid max-h-48 gap-1.5 overflow-y-auto py-1"
      >
        {displayed.map((excerpt, index) => {
          const checked = selected.includes(excerpt.id)
          const fromUser = excerpt.role === 'user'
          const isSelection = selection?.excerpt.id === excerpt.id
          const partiallyChecked = checked && partial(excerpt.id)
          const fade = !isSelection && !showAll && index === displayed.length - 1 && index > 0
          return (
            <Fragment key={excerpt.id}>
              <div
                className={
                  isSelection
                    ? `relative min-w-0 ${fromUser ? 'max-w-[90%] justify-self-end' : ''}`
                    : 'contents'
                }
              >
                <Button
                  variant="unstyled"
                  showTooltip={false}
                  type="button"
                  aria-pressed={partiallyChecked ? 'mixed' : checked}
                  data-testid="task-issue-share-excerpt"
                  onClick={() => toggle(excerpt.id)}
                  className={`group flex min-h-11 min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted md:min-h-8 ${checked ? 'bg-muted' : ''} ${fromUser ? (isSelection ? 'w-full bg-muted/60' : 'max-w-[90%] justify-self-end bg-muted/60') : 'w-full'} ${isSelection ? 'pr-11' : ''}`}
                >
                  <span
                    aria-hidden="true"
                    className={`${isSelection ? 'sticky top-2 self-start' : ''} mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${checked ? 'border-text-primary bg-text-primary text-background' : 'border-text-secondary group-hover:border-text-primary'}`}
                  >
                    {checked &&
                      (partiallyChecked ? (
                        <Minus data-testid="task-issue-share-excerpt-partial" className="size-3" />
                      ) : (
                        <Check data-testid="task-issue-share-excerpt-check" className="size-3" />
                      ))}
                  </span>
                  <span className="sr-only">{t(`taskIssueShare.${excerpt.role}`)}</span>
                  <span
                    data-testid={`task-issue-share-excerpt-content-${index}`}
                    className={`min-w-0 whitespace-pre-wrap break-words text-text-primary ${showAll || isSelection ? '' : 'line-clamp-2'} ${fade ? '[mask-image:linear-gradient(to_bottom,black_45%,transparent)]' : ''}`}
                  >
                    {isSelection && shareWholeMessage ? (
                      <mark
                        data-testid="task-issue-share-highlight"
                        className="rounded-sm bg-yellow-300/40 text-text-primary"
                      >
                        {excerpt.content}
                      </mark>
                    ) : isSelection ? (
                      <>
                        {excerpt.content.slice(0, selection.start)}
                        <mark
                          data-testid="task-issue-share-highlight"
                          className="rounded-sm bg-yellow-300/40 text-text-primary"
                        >
                          {excerpt.content.slice(selection.start, selection.end)}
                        </mark>
                        {excerpt.content.slice(selection.end)}
                      </>
                    ) : (
                      excerpt.content
                    )}
                  </span>
                </Button>
                {isSelection && hasPartialRange && (
                  <div className="pointer-events-none absolute inset-y-1 right-1">
                    <Button
                      variant="unstyled"
                      type="button"
                      data-testid="task-issue-share-whole-message"
                      aria-pressed={shareWholeMessage}
                      aria-label={t(
                        shareWholeMessage
                          ? 'taskIssueShare.shareSelectionOnly'
                          : 'taskIssueShare.shareWholeMessage'
                      )}
                      title={t(
                        shareWholeMessage
                          ? 'taskIssueShare.shareSelectionOnly'
                          : 'taskIssueShare.shareWholeMessage'
                      )}
                      onClick={() => {
                        onShareWholeMessage?.(!shareWholeMessage)
                        if (!checked) onSelect([...selected, excerpt.id])
                      }}
                      className="pointer-events-auto sticky top-1 flex size-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary md:size-7"
                    >
                      {shareWholeMessage ? (
                        <Shrink className="size-4" aria-hidden="true" />
                      ) : (
                        <Expand className="size-4" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                )}
              </div>
              {showHistoryGap && index === 0 && historyAction}
            </Fragment>
          )
        })}
      </div>
      {!showHistoryGap && historyAction}
      {showAll && loadEarlier && (
        <Button
          variant="unstyled"
          showTooltip={false}
          type="button"
          data-testid="task-issue-share-collapse-excerpts"
          disabled={loading}
          onClick={() => setShowAll(false)}
          className="flex min-h-11 w-full items-center justify-center gap-1 rounded-md text-xs text-text-secondary hover:bg-muted md:min-h-8"
        >
          {t('taskIssueShare.recentExcerpts')}
          <ChevronUp aria-hidden="true" className="size-3.5" />
        </Button>
      )}
      {failed && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {t('taskIssueShare.earlierUnavailable')}
        </p>
      )}
    </section>
  )
}
