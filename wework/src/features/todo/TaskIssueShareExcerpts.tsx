import { Button } from '@wegent/collaboration/markdown/Button'
import { Fragment, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Ellipsis, Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { TaskIssueShareDraft } from './TaskIssueShare'

export function TaskIssueShareExcerpts({
  excerpts,
  firstAvailable,
  selected,
  onSelect,
  loadEarlier,
}: {
  excerpts: TaskIssueShareDraft['excerpts']
  firstAvailable: boolean
  selected: string[]
  onSelect(ids: string[]): void
  loadEarlier?(): Promise<void>
}) {
  const { t } = useTranslation('common')
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const displayed = showAll
    ? excerpts
    : firstAvailable && excerpts.length > 1
      ? [excerpts[0], excerpts[excerpts.length - 1]]
      : excerpts.slice(-1)
  const toggle = (id: string) =>
    onSelect(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id])
  const allSelected = displayed.every(excerpt => selected.includes(excerpt.id))
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
      <div className="grid max-h-48 gap-1.5 overflow-y-auto py-1">
        {displayed.map((excerpt, index) => {
          const checked = selected.includes(excerpt.id)
          const fromUser = excerpt.role === 'user'
          const fade = !showAll && index === 1
          return (
            <Fragment key={excerpt.id}>
              <Button
                variant="unstyled"
                showTooltip={false}
                type="button"
                aria-pressed={checked}
                data-testid="task-issue-share-excerpt"
                onClick={() => toggle(excerpt.id)}
                className={`group flex min-h-11 min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted aria-pressed:bg-muted md:min-h-8 ${fromUser ? 'max-w-[90%] justify-self-end bg-muted/60' : 'w-full'}`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${checked ? 'border-text-primary bg-text-primary text-background' : 'border-text-secondary group-hover:border-text-primary'}`}
                >
                  {checked && (
                    <Check data-testid="task-issue-share-excerpt-check" className="size-3" />
                  )}
                </span>
                <span className="sr-only">{t(`taskIssueShare.${excerpt.role}`)}</span>
                <span
                  data-testid={`task-issue-share-excerpt-content-${index}`}
                  className={`min-w-0 whitespace-pre-wrap break-words text-text-primary ${showAll ? '' : 'line-clamp-2'} ${fade ? '[mask-image:linear-gradient(to_bottom,black_45%,transparent)]' : ''}`}
                >
                  {excerpt.content}
                </span>
              </Button>
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
