import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { TaskIssueShareDraft } from './TaskIssueShare'

const modes = ['single', 'multiple'] as const

export function TaskIssueShareExcerpts({
  excerpts,
  selected,
  onSelect,
}: {
  excerpts: TaskIssueShareDraft['excerpts']
  selected: string[]
  onSelect(ids: string[]): void
}) {
  const { t } = useTranslation('common')
  const groupName = useId()
  const [mode, setMode] = useState<(typeof modes)[number]>('multiple')
  const [expanded, setExpanded] = useState<string | null>(null)
  if (!excerpts.length) return null

  return (
    <details className="rounded-lg border border-border">
      <summary
        data-testid="task-issue-share-excerpts"
        className="min-h-11 cursor-pointer rounded-lg px-3 py-2 text-sm keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:min-h-8"
      >
        {t('taskIssueShare.excerpts', { count: selected.length })}
      </summary>
      <div className="flex flex-wrap items-center justify-between gap-1 border-t border-border px-2 py-1">
        <div
          role="group"
          aria-label={t('taskIssueShare.excerptSelectionMode')}
          className="inline-flex rounded-md bg-muted p-0.5"
        >
          {modes.map(option => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              data-testid={`task-issue-share-excerpt-mode-${option}`}
              onClick={() => {
                setMode(option)
                if (option === 'single' && selected.length > 1) onSelect(selected.slice(-1))
              }}
              className="min-h-10 rounded px-3 text-sm text-text-secondary hover:text-text-primary aria-pressed:bg-background aria-pressed:font-medium aria-pressed:text-text-primary md:min-h-7"
            >
              {t(`taskIssueShare.excerptMode_${option}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="task-issue-share-clear-excerpts"
          disabled={!selected.length}
          onClick={() => onSelect([])}
          className="min-h-10 rounded px-2 text-sm text-text-secondary hover:bg-muted disabled:opacity-50 md:min-h-7"
        >
          {t('taskIssueShare.clearExcerpts')}
        </button>
      </div>
      <div className="max-h-56 divide-y divide-border overflow-y-auto border-t border-border">
        {excerpts.map((excerpt, index) => {
          const isExpanded = expanded === excerpt.id
          const contentId = `${groupName}-excerpt-${index}`
          return (
            <div key={excerpt.id} className="flex min-w-0 items-start gap-1 px-2 py-1">
              <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                <input
                  type={mode === 'single' ? 'radio' : 'checkbox'}
                  name={mode === 'single' ? groupName : undefined}
                  data-testid="task-issue-share-excerpt"
                  className="mt-1 shrink-0 accent-text-primary"
                  checked={selected.includes(excerpt.id)}
                  onChange={event => {
                    onSelect(
                      mode === 'single'
                        ? [excerpt.id]
                        : event.target.checked
                          ? [...selected, excerpt.id]
                          : selected.filter(id => id !== excerpt.id)
                    )
                  }}
                />
                <span className="min-w-0">
                  <span className="block font-medium">{t(`taskIssueShare.${excerpt.role}`)}</span>
                  <span
                    id={contentId}
                    data-testid={`task-issue-share-excerpt-content-${index}`}
                    className={`whitespace-pre-wrap break-words text-text-secondary ${isExpanded ? 'block' : 'line-clamp-2'}`}
                  >
                    {excerpt.content}
                  </span>
                </span>
              </label>
              <button
                type="button"
                data-testid={`task-issue-share-excerpt-expand-${index}`}
                aria-controls={contentId}
                aria-expanded={isExpanded}
                onClick={() => setExpanded(isExpanded ? null : excerpt.id)}
                className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-8 md:min-w-8"
                aria-label={t(
                  isExpanded ? 'taskIssueShare.collapseExcerpt' : 'taskIssueShare.expandExcerpt'
                )}
              >
                <ChevronDown
                  className={`h-4 w-4 ${isExpanded ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>
          )
        })}
      </div>
    </details>
  )
}
