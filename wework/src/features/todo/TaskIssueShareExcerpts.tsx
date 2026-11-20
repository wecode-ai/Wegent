import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { TaskIssueShareDraft } from './TaskIssueShare'

export function TaskIssueShareExcerpts({
  excerpts,
  selected,
  onSelect,
  loadAll,
}: {
  excerpts: TaskIssueShareDraft['excerpts']
  selected: string[]
  onSelect(ids: string[]): void
  loadAll?(): Promise<TaskIssueShareDraft['excerpts']>
}) {
  const { t } = useTranslation('common')
  const [showAll, setShowAll] = useState(false)
  const [previewEnd, setPreviewEnd] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!excerpts.length) return null
  const displayed = showAll ? excerpts : previewEnd ? excerpts.slice(-2) : excerpts.slice(0, 2)
  const toggle = (id: string) =>
    onSelect(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id])
  const allSelected = selected.length === excerpts.length
  async function withAll(action: (items: TaskIssueShareDraft['excerpts']) => void) {
    setLoading(true)
    setFailed(false)
    try {
      action((await loadAll?.()) ?? excerpts)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section
      data-testid="task-issue-share-excerpts"
      aria-label={t('taskIssueShare.excerpts')}
      className="min-w-0"
    >
      <div className="flex flex-wrap gap-x-2 px-2 pt-1">
        <button
          type="button"
          data-testid="task-issue-share-select-all"
          aria-pressed={allSelected}
          disabled={loading}
          onClick={() =>
            void withAll(items =>
              onSelect(selected.length === items.length ? [] : items.map(excerpt => excerpt.id))
            )
          }
          className="min-h-10 rounded px-2 text-xs text-text-secondary hover:bg-muted md:min-h-7"
        >
          {t('taskIssueShare.selectAll')}
        </button>
        {excerpts.length > 1 &&
          (['first', 'last'] as const).map(position => {
            const excerpt = excerpts[position === 'first' ? 0 : excerpts.length - 1]
            return (
              <button
                key={position}
                type="button"
                data-testid={`task-issue-share-select-${position}`}
                aria-pressed={selected.includes(excerpt.id)}
                onClick={() => {
                  setShowAll(false)
                  setPreviewEnd(position === 'last')
                  toggle(excerpt.id)
                }}
                className="min-h-10 rounded px-2 text-xs text-text-secondary hover:bg-muted md:min-h-7"
              >
                {t(`taskIssueShare.select_${position}`)}
              </button>
            )
          })}
      </div>
      <div className="grid max-h-48 gap-1.5 overflow-y-auto px-2 pb-1 pt-2">
        {displayed.map((excerpt, index) => {
          const checked = selected.includes(excerpt.id)
          const fromUser = excerpt.role === 'user'
          const fade = !showAll && index === 1
          return (
            <button
              key={excerpt.id}
              type="button"
              aria-pressed={checked}
              data-testid="task-issue-share-excerpt"
              onClick={() => toggle(excerpt.id)}
              className={`flex min-h-11 min-w-0 items-start gap-2 px-3 py-2 text-left text-sm hover:bg-muted md:min-h-8 ${fromUser ? 'max-w-[85%] justify-self-end rounded-2xl bg-muted' : 'rounded-lg'}`}
            >
              <span className="sr-only">{t(`taskIssueShare.${excerpt.role}`)}</span>
              <span
                data-testid={`task-issue-share-excerpt-content-${index}`}
                className={`min-w-0 whitespace-pre-wrap break-words text-text-primary ${showAll ? '' : 'line-clamp-2'} ${fade ? '[mask-image:linear-gradient(to_bottom,black_45%,transparent)]' : ''}`}
              >
                {excerpt.content}
              </span>
              {checked && (
                <Check
                  data-testid="task-issue-share-excerpt-check"
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0"
                />
              )}
            </button>
          )
        })}
      </div>
      <button
        type="button"
        data-testid="task-issue-share-all-excerpts"
        aria-expanded={showAll}
        disabled={loading}
        onClick={() => (showAll ? setShowAll(false) : void withAll(() => setShowAll(true)))}
        className="flex min-h-11 w-full items-center justify-center gap-1 border-t border-border px-2 py-1 text-xs text-text-secondary hover:bg-muted md:min-h-8"
      >
        {t(
          loading
            ? 'independentIssues.loading'
            : showAll
              ? 'taskIssueShare.recentExcerpts'
              : loadAll
                ? 'taskIssueShare.allHistory'
                : 'taskIssueShare.allExcerpts',
          {
            count: excerpts.length,
          }
        )}
        <ChevronDown className={`size-3.5 ${showAll ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {failed && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {t('taskIssueShare.historyUnavailable')}
        </p>
      )}
    </section>
  )
}
