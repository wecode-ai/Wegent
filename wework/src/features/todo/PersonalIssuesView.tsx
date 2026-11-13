import { useIndependentIssuePage } from './useIndependentIssuePage'
import { IndependentIssueList } from './IndependentIssueList'
import { useIndependentIssues } from './independentIssuesContext'
import { useState } from 'react'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { PersonalIssueList } from './PersonalIssueList'
import { usePersonalHomeIssues, type PersonalHomeIssueOrder } from './usePersonalHomeIssues'

export function PersonalIssuesView({
  scope,
  sources,
  projects,
  userId,
  localUserIds,
  active,
  onOpenIssue,
}: {
  scope: 'assigned' | 'created' | 'participating'
  sources: SharedWorkspaceApi[]
  projects: CollaborationProject[]
  userId: number
  localUserIds?: readonly (string | number)[]
  active: boolean
  onOpenIssue(issue: WorkspaceMyWorkItem): void
}) {
  const { t } = useTranslation('common')
  const independent = useIndependentIssues()
  const [archived, setArchived] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [order, setOrder] = useState<PersonalHomeIssueOrder>('attention')
  const independentPage = useIndependentIssuePage(scope, showCompleted, active, archived, order)
  const state = usePersonalHomeIssues(
    sources,
    active && !archived,
    scope === 'assigned',
    showCompleted,
    localUserIds ?? [userId],
    order,
    scope
  )
  return (
    <main
      className="min-h-0 flex-1 overflow-auto p-5 lg:p-8"
      data-testid={`personal-issues-${scope}`}
    >
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-heading-md font-medium">{t(`personalIssues.${scope}`)}</h1>
          {independent ? (
            <button
              type="button"
              data-testid="personal-issues-create"
              onClick={independent.create}
              className="min-h-11 rounded-md bg-text-primary px-3 text-sm text-background md:min-h-8"
            >
              {t('independentIssues.create')}
            </button>
          ) : null}
        </div>
        <p className="mt-2 text-base text-text-secondary">{t(`personalIssues.${scope}Hint`)}</p>
        <div className="my-5 flex flex-wrap justify-end gap-2">
          <select
            aria-label={t('personalHome.sort')}
            data-testid="personal-issues-sort"
            value={order}
            onChange={event => setOrder(event.target.value as PersonalHomeIssueOrder)}
            className="wework-native-select min-h-11 rounded-md bg-transparent px-2 text-sm md:min-h-8"
          >
            {(['attention', 'assignment', 'activity', 'priority'] as const).map(value => (
              <option key={value} value={value}>
                {t(`personalHome.sort_${value}`)}
              </option>
            ))}
          </select>
          <select
            aria-label={t('personalHome.filter')}
            data-testid="personal-issues-filter"
            value={showCompleted ? 'all' : 'open'}
            onChange={event => setShowCompleted(event.target.value === 'all')}
            className="wework-native-select min-h-11 rounded-md bg-transparent px-2 text-sm md:min-h-8"
          >
            <option value="open">{t('personalHome.open')}</option>
            <option value="all">{t('personalHome.all')}</option>
          </select>
        </div>
        <label className="mb-4 flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="personal-issues-archived"
            checked={archived}
            onChange={event => setArchived(event.target.checked)}
          />
          {t('independentIssues.showArchived')}
        </label>
        <IndependentIssueList state={independentPage} hideWhenEmpty={!archived} />
        {!archived ? (
          <PersonalIssueList
            hideEmpty={independentPage.loading || independentPage.items.length > 0}
            userId={userId}
            localUserIds={localUserIds}
            state={state}
            projects={projects}
            showCompleted={showCompleted}
            assignedOnly={scope === 'assigned'}
            onOpenIssue={onOpenIssue}
            active={active}
            onOpenTask={onOpenIssue}
            order={order}
          />
        ) : null}
        {!archived && state.hasMore ? (
          <button
            type="button"
            disabled={state.loading}
            data-testid="personal-issues-load-more"
            onClick={() => void state.loadMore()}
            className="min-h-11 rounded-md px-3 text-sm text-text-secondary hover:bg-muted md:min-h-8"
          >
            {t('personalHome.loadMore')}
          </button>
        ) : null}
      </div>
    </main>
  )
}
