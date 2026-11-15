import {
  CollaborationIssueCard,
  createCollaborationTranslator,
  createIssueBoardCardLabels,
} from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import type { useIndependentIssuePage } from './useIndependentIssuePage'

export function IndependentIssueList({
  state,
  hideWhenEmpty = false,
  onOpenIssue,
  selectedId,
}: {
  state: ReturnType<typeof useIndependentIssuePage>
  hideWhenEmpty?: boolean
  onOpenIssue?(id: string): void
  selectedId?: string
}) {
  const { t, i18n } = useTranslation('common')
  const labels = createIssueBoardCardLabels(
    createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')
  )
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
                : issue.assignee_id === state.context?.userId
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
            'aria-current':
              (selectedId ?? state.context?.selectedId) === issue.id ? 'true' : undefined,
          }}
          cardClassName="cursor-pointer aria-[current=true]:bg-muted"
          onOpen={() => (onOpenIssue ?? state.context?.open)?.(issue.id)}
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
