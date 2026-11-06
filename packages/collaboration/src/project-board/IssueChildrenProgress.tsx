import type { CollaborationTranslate } from '../i18n'
import type { CollaborationIssue } from '../types'

interface ChildrenProgress {
  completed: number
  total: number
}

export function collectIssueChildrenProgress(
  issues: readonly Pick<
    CollaborationIssue,
    'id' | 'parent_id' | 'status' | 'can_view_detail' | 'archived_at'
  >[]
): Map<string, ChildrenProgress> {
  const result = new Map<string, ChildrenProgress>()
  const seen = new Set<string>()
  for (const issue of issues) {
    if (
      !issue.parent_id ||
      issue.can_view_detail === false ||
      issue.archived_at ||
      seen.has(issue.id)
    ) {
      continue
    }
    seen.add(issue.id)
    const progress = result.get(issue.parent_id) ?? { completed: 0, total: 0 }
    progress.total += 1
    if (issue.status === 'completed') progress.completed += 1
    result.set(issue.parent_id, progress)
  }
  return result
}

export function IssueChildrenProgress({
  itemId,
  progress,
  translate: t,
  onOpen,
}: {
  itemId: string
  progress: ChildrenProgress
  translate: CollaborationTranslate
  onOpen(): void
}) {
  const { completed, total } = progress
  const hint = t('todo.card_children_progress_hint', undefined, {
    completed,
    total,
  })
  return (
    <button
      type="button"
      data-testid={`collaboration-issue-children-${itemId}`}
      aria-label={hint}
      title={hint}
      onClick={event => {
        event.stopPropagation()
        onOpen()
      }}
      className="mx-3 mb-3 inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 text-text-secondary hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 md:min-h-7"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className={`h-3.5 w-3.5 shrink-0 ${completed === total ? 'text-emerald-600 dark:text-emerald-400' : ''}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="8" cy="8" r="6" className="text-text-muted/25" />
        <circle
          cx="8"
          cy="8"
          r="6"
          pathLength="1"
          strokeDasharray={`${completed / total} 1`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span className="tabular-nums text-xs">
        {t('todo.card_children_progress', undefined, { completed, total })}
      </span>
    </button>
  )
}
