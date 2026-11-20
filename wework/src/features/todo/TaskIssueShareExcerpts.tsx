import { useTranslation } from '@/hooks/useTranslation'
import type { TaskIssueShareDraft } from './TaskIssueShare'

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
  if (!excerpts.length) return null

  return (
    <details className="rounded-lg border border-border">
      <summary
        data-testid="task-issue-share-excerpts"
        className="min-h-11 cursor-pointer rounded-lg px-3 py-2 text-sm keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:min-h-8"
      >
        {t('taskIssueShare.excerpts', { count: selected.length })}
      </summary>
      <div className="grid max-h-64 divide-y divide-border overflow-y-auto border-t border-border">
        {excerpts.map(excerpt => (
          <label
            key={excerpt.id}
            className="flex min-h-11 min-w-0 cursor-pointer items-start gap-2 px-3 py-2 text-sm hover:bg-muted"
          >
            <input
              type="checkbox"
              data-testid="task-issue-share-excerpt"
              className="mt-1 shrink-0 accent-primary"
              checked={selected.includes(excerpt.id)}
              onChange={event => {
                onSelect(
                  event.target.checked
                    ? [...selected, excerpt.id]
                    : selected.filter(id => id !== excerpt.id)
                )
              }}
            />
            <span className="min-w-0">
              <span className="block font-medium">{t(`taskIssueShare.${excerpt.role}`)}</span>
              <span className="block whitespace-pre-wrap break-words text-text-secondary">
                {excerpt.content}
              </span>
            </span>
          </label>
        ))}
      </div>
    </details>
  )
}
