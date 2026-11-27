import { selectedShareExcerpts } from './selectedShareExcerpts'
import { Button } from '../markdown/Button'
import { Fragment, useRef, useState, type ReactNode } from 'react'
import { useScrollRequest } from '../dom-events'
import { Check, ChevronDown, ChevronUp, Expand, Loader2, Minus, Shrink } from 'lucide-react'
import { usePersonalIssueTranslation } from './personalIssueMessages'
import ReactMarkdown from 'react-markdown'
import { preprocessCjkEmphasis } from '../markdown/preprocessCjkEmphasis'
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
  renderShareContent,
}: {
  excerpts: TaskIssueShareDraft['excerpts']
  selection?: TaskIssueShareDraft['selectedExcerpt']
  shareWholeMessage?: boolean
  onShareWholeMessage?(whole: boolean): void
  firstAvailable: boolean
  selected: string[]
  onSelect(ids: string[]): void
  loadEarlier?(): Promise<void>
  renderShareContent?(messages: ReactNode, messageActions: ReactNode): ReactNode
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
    if (selection?.excerpt.id === id) onShareWholeMessage?.(false)
    onSelect(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id])
  }
  const selectedIds = new Set(selected)
  const visibleSelectedCount = displayed.filter(excerpt => selectedIds.has(excerpt.id)).length
  const allSelected = visibleSelectedCount === displayed.length
  const hiddenSelectedCount = selectedIds.size - visibleSelectedCount
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

  if (displayed.length === 0 && !loadEarlier) return renderShareContent?.(null, null) ?? null

  const expandCached = !showAll && excerpts.length > 2
  const showHistoryGap =
    firstAvailable && displayed.length > 1 && (Boolean(loadEarlier) || expandCached)
  const showEarlierAtStart = !firstAvailable && Boolean(loadEarlier)
  const historyLabel = t(
    loading
      ? 'independentIssues.loading'
      : showHistoryGap
        ? showAll
          ? 'taskIssueShare.showMoreMiddleMessages'
          : 'taskIssueShare.showMiddleMessages'
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
      disabled={loading}
      onClick={() => (loadEarlier && !expandCached ? void fetchEarlier() : setShowAll(!showAll))}
      className={`flex min-h-11 items-center justify-center gap-2 rounded-md px-2 py-1 text-xs text-text-secondary hover:text-text-primary md:min-h-8 ${showHistoryGap ? 'justify-self-center hover:bg-muted' : 'w-full before:flex-1 before:border-t before:border-border after:flex-1 after:border-t after:border-border'}`}
    >
      {historyLabel}
      {loading ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : !showHistoryGap && (loadEarlier || showAll) ? (
        <ChevronUp className="size-3.5" aria-hidden="true" />
      ) : (
        <ChevronDown className="size-3.5" aria-hidden="true" />
      )}
    </Button>
  )

  const messageActions = (
    <div className="flex shrink-0 items-center gap-2">
      {hiddenSelectedCount > 0 && (
        <span role="status" className="text-xs text-text-secondary">
          {t('taskIssueShare.hiddenSelected', { count: hiddenSelectedCount })}
        </span>
      )}
      <Button
        variant="unstyled"
        showTooltip={false}
        type="button"
        data-testid="task-issue-share-select-all"
        aria-label={t('taskIssueShare.selectVisibleMessages')}
        title={t('taskIssueShare.selectVisibleMessages')}
        aria-pressed={allSelected}
        disabled={loading || displayed.length === 0}
        onClick={() => {
          const visible = new Set(displayed.map(excerpt => excerpt.id))
          onSelect(
            allSelected
              ? selected.filter(id => !visible.has(id))
              : [...new Set([...selected, ...visible])]
          )
        }}
        className="min-h-11 whitespace-nowrap rounded-md px-2 text-xs text-text-secondary hover:bg-muted aria-pressed:bg-muted aria-pressed:text-text-primary md:min-h-7"
      >
        {t('taskIssueShare.selectAll')}
      </Button>
    </div>
  )
  const messages = (
    <section
      data-testid="task-issue-share-excerpts"
      aria-label={t('taskIssueShare.excerpts')}
      className="min-w-0"
    >
      <div
        ref={excerptsRef}
        data-testid="task-issue-share-message-list"
        className={`grid content-start gap-1.5 overflow-y-auto py-1 ${showAll ? 'min-h-48 max-h-80' : 'min-h-40 max-h-64'}`}
      >
        {showEarlierAtStart && historyAction}
        {displayed.map((excerpt, index) => {
          const checked = selected.includes(excerpt.id)
          const fromUser = excerpt.role === 'user'
          const isSelection = selection?.excerpt.id === excerpt.id
          const partiallyChecked = checked && partial(excerpt.id)
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
                    className={`min-w-0 whitespace-pre-wrap break-words text-text-primary ${showAll || isSelection ? '' : 'line-clamp-4'} ${!showAll && !isSelection && index === displayed.length - 1 ? '[mask-image:linear-gradient(to_bottom,black_3lh,transparent_4lh)]' : ''}`}
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
                      <ReactMarkdown
                        allowedElements={['strong', 'em', 'code', 'del', 'br']}
                        unwrapDisallowed
                      >
                        {preprocessCjkEmphasis(excerpt.content)}
                      </ReactMarkdown>
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
      {!showHistoryGap && !showEarlierAtStart && historyAction}
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
  return renderShareContent ? renderShareContent(messages, messageActions) : messages
}
