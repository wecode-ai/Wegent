import { useTranslation } from '@/hooks/useTranslation'
import type { useIndependentIssuePage } from './useIndependentIssuePage'

export function IndependentIssueList({
  state,
  hideWhenEmpty = false,
}: {
  state: ReturnType<typeof useIndependentIssuePage>
  hideWhenEmpty?: boolean
}) {
  const { t } = useTranslation('common')
  if (
    !state.context?.api ||
    (hideWhenEmpty && !state.loading && !state.error && !state.items.length)
  )
    return null
  return (
    <section
      className="mb-6"
      data-testid="independent-issue-list"
      aria-label={t('independentIssues.independent')}
    >
      <h3 className="mb-2 text-base font-medium text-text-secondary">
        {t('independentIssues.independent')}
      </h3>
      {state.loading ? (
        <p role="status" className="py-3 text-sm text-text-secondary">
          {t('independentIssues.loading')}
        </p>
      ) : null}
      {!state.loading && !state.error && !state.items.length ? (
        <p className="py-3 text-sm text-text-secondary">{t('independentIssues.empty')}</p>
      ) : null}
      {state.items.map(issue => (
        <button
          type="button"
          key={issue.id}
          data-testid={`independent-issue-${issue.id}`}
          onClick={() => state.context?.open(issue.id)}
          className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 border-b border-border py-4 text-left hover:bg-muted md:min-h-8"
        >
          <span className="min-w-0 flex-1">
            <span className="block break-words text-base">{issue.title}</span>
            <span className="mt-1 block line-clamp-2 text-sm text-text-secondary">
              {issue.description}
            </span>
            <span className="mt-2 block text-xs text-text-secondary">
              {issue.assignee_id == null
                ? t('independentIssues.unassigned')
                : issue.assignee_id === state.context?.userId
                  ? t('personalHome.me')
                  : (issue.people[issue.assignee_id] ?? `#${issue.assignee_id}`)}
            </span>
          </span>
          <span className="rounded-md bg-muted px-2 py-1 text-xs text-text-secondary">
            {t(`independentIssues.${issue.status}`)}
          </span>
        </button>
      ))}
      {state.hasMore ? (
        <button
          type="button"
          data-testid="independent-issues-load-more"
          onClick={() => void state.loadMore()}
          className="min-h-11 rounded-md px-3 text-sm hover:bg-muted md:min-h-8"
        >
          {t('personalHome.loadMore')}
        </button>
      ) : null}
    </section>
  )
}
