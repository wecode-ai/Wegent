import { CollaborationIssueCard } from '../issue-card'
import { createIssueBoardCardLabels } from '../issue-card'
import { createCollaborationTranslator, type CollaborationLocale } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'
import type { useIndependentIssuePage } from './useIndependentIssuePage'

export function IndependentIssueList({
  state,
  hideWhenEmpty = false,
  onOpenIssue,
  selectedId,
  locale,
  translate: t,
  userId,
}: {
  state: ReturnType<typeof useIndependentIssuePage>
  hideWhenEmpty?: boolean
  onOpenIssue(id: string): void
  selectedId?: string
  locale: CollaborationLocale
  translate(key: string): string
  userId: number
}) {
  const labels = createIssueBoardCardLabels(createCollaborationTranslator(locale))
  if (hideWhenEmpty && !state.loading && !state.error && !state.items.length) return null
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
        <CollaborationIssueCard
          key={issue.id}
          variant="list"
          item={{
            ...issue,
            assignee_user_id: issue.assignee_id,
            assignee_agent_id:
              issue.metadata.assignee_resource?.kind === 'agent'
                ? String(issue.metadata.assignee_resource.id)
                : null,
            assignee_agent_name: issue.metadata.resource_participants?.find(
              resource =>
                resource.kind === 'agent' && resource.id === issue.metadata.assignee_resource?.id
            )?.name,
            assignee_group_id:
              issue.metadata.assignee_resource?.kind === 'group'
                ? String(issue.metadata.assignee_resource.id)
                : null,
            assignee_group_name: issue.metadata.resource_participants?.find(
              resource =>
                resource.kind === 'group' && resource.id === issue.metadata.assignee_resource?.id
            )?.name,
            assignee_name:
              issue.assignee_id == null
                ? null
                : issue.assignee_id === userId
                  ? t('personalHome.me')
                  : (issue.people[issue.assignee_id] ?? '#' + issue.assignee_id),
          }}
          reference=""
          labels={{
            ...labels,
            statuses: {
              pending: t('independentIssues.pending'),
              in_progress: t('independentIssues.in_progress'),
              completed: t('independentIssues.completed'),
            },
          }}
          display={{
            showAssignee: true,
            showPriority: true,
            showTags: false,
            showDate: true,
            showReference: false,
          }}
          detailButtonTestId={`independent-issue-${issue.id}`}
          articleProps={{
            'aria-current': selectedId === issue.id ? 'true' : undefined,
          }}
          cardClassName="cursor-pointer aria-[current=true]:bg-muted"
          onOpen={() => onOpenIssue(issue.id)}
          summary={
            issue.description ? (
              <p className="mt-1 line-clamp-1 text-sm leading-5 text-text-secondary">
                {issue.description}
              </p>
            ) : undefined
          }
        />
      ))}
      {state.hasMore ? (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="independent-issues-load-more"
          onClick={() => void state.loadMore()}
          className="min-h-11 rounded-md px-3 text-sm hover:bg-muted md:min-h-8"
        >
          {t('personalHome.loadMore')}
        </ControlButton>
      ) : null}
    </section>
  )
}
