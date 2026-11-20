import { useTranslation } from '@/hooks/useTranslation'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { IndependentIssueDialog } from './IndependentIssueDialog'
import { IndependentIssueList } from './IndependentIssueList'
import { useIndependentIssues } from './independentIssuesContext'
import { PersonalIssueErrors } from './PersonalIssueErrors'
import { PersonalIssueList } from './PersonalIssueList'
import { useIndependentIssuePage } from './useIndependentIssuePage'
import { usePersonalHomeIssues, type PersonalHomeIssueOrder } from './usePersonalHomeIssues'
import type { PersonalHomeIssueDetailContext } from './WeworkPersonalHome'

export function PersonalIssuesView({
  scope,
  sources,
  projects,
  userId,
  localUserIds,
  active,
  onOpenIssue,
  onOpenProject,
  renderIssueDetail,
}: {
  scope: 'assigned' | 'created' | 'participating'
  sources: SharedWorkspaceApi[]
  projects: CollaborationProject[]
  userId: number
  localUserIds?: readonly (string | number)[]
  active: boolean
  onOpenIssue(issue: WorkspaceMyWorkItem): void
  onOpenProject(project: CollaborationProject): void
  renderIssueDetail(context: PersonalHomeIssueDetailContext): ReactNode
}) {
  const { t } = useTranslation('common')
  const independent = useIndependentIssues()
  const [archived, setArchived] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [order, setOrder] = useState<PersonalHomeIssueOrder>('attention')
  const [expanded, setExpanded] = useState(false)
  const [detailExpanded, setDetailExpanded] = useState(false)
  const [selected, setSelected] = useState<{
    issue: WorkspaceMyWorkItem
    taskRequest?: PersonalHomeIssueDetailContext['taskRequest']
  }>()
  const [independentId, setIndependentId] = useState<string>()
  const [detailScope, setDetailScope] = useState({ userId, sources })
  if (
    detailScope.userId !== userId ||
    detailScope.sources.length !== sources.length ||
    detailScope.sources.some((source, index) => source !== sources[index])
  ) {
    setDetailScope({ userId, sources })
    setSelected(undefined)
    setIndependentId(undefined)
    setExpanded(false)
  }
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
  const project = projects.find(project => project.id === selected?.issue.cloud_project_id)
  const openIssue = (
    issue: WorkspaceMyWorkItem,
    taskRequest?: PersonalHomeIssueDetailContext['taskRequest']
  ) => {
    setIndependentId(undefined)
    setSelected({ issue, taskRequest })
  }
  return (
    <div className="issue-drawer-workspace relative flex h-full min-h-0 min-w-0 flex-1">
      <main
        className="min-h-0 min-w-0 flex-1 overflow-auto p-4 lg:p-5"
        data-testid={`personal-issues-${scope}`}
      >
        <div className="mx-auto w-full max-w-6xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-heading-md font-medium">{t(`personalIssues.${scope}`)}</h1>
            {independent ? (
              <ControlButton
                variant="primary"
                size="sm"
                type="button"
                data-testid="personal-issues-create"
                onClick={independent.create}
                className="min-h-11 rounded-md bg-text-primary px-3 text-sm text-background md:min-h-8"
              >
                {t('independentIssues.create')}
              </ControlButton>
            ) : null}
          </div>
          <p className="mt-2 text-base text-text-secondary">{t(`personalIssues.${scope}Hint`)}</p>
          <div
            className="my-5 flex flex-wrap items-center justify-end gap-2"
            data-testid="personal-issues-toolbar"
          >
            {independent ? (
              <label className="mr-auto flex min-h-11 items-center gap-2 text-sm md:min-h-8">
                <Checkbox
                  data-testid="personal-issues-archived"
                  checked={archived}
                  onCheckedChange={checked => setArchived(checked === true)}
                />
                {t('independentIssues.showArchived')}
              </label>
            ) : null}
            <SelectRoot
              value={normalizeSelectValue(order)}
              onValueChange={selectedValue => {
                if (selectedValue !== null) return setOrder(selectedValue as PersonalHomeIssueOrder)
              }}
            >
              <SelectTrigger
                density="compact"
                appearance="plain"
                aria-label={t('personalHome.sort')}
                data-testid="personal-issues-sort"
                className="wework-native-select"
              />
              <SelectContent>
                {(['attention', 'assignment', 'activity', 'priority'] as const).map(value => (
                  <SelectItem key={value} value={String(value)}>
                    {t(`personalHome.sort_${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
            <SelectRoot
              value={normalizeSelectValue(showCompleted ? 'all' : 'open')}
              onValueChange={selectedValue => {
                if (selectedValue !== null) return setShowCompleted(selectedValue === 'all')
              }}
            >
              <SelectTrigger
                density="compact"
                appearance="plain"
                aria-label={t('personalHome.filter')}
                data-testid="personal-issues-filter"
                className="wework-native-select"
              />
              <SelectContent>
                <SelectItem value="open">{t('personalHome.open')}</SelectItem>
                <SelectItem value="all">{t('personalHome.all')}</SelectItem>
              </SelectContent>
            </SelectRoot>
          </div>
          <PersonalIssueErrors
            projects={archived ? undefined : state}
            independent={independentPage}
          />
          <IndependentIssueList
            state={independentPage}
            hideWhenEmpty={!archived}
            onOpenIssue={id => {
              setSelected(undefined)
              setIndependentId(id)
            }}
            selectedId={independentId}
          />
          {!archived ? (
            <PersonalIssueList
              hideEmpty={independentPage.loading || independentPage.items.length > 0}
              userId={userId}
              localUserIds={localUserIds}
              state={state}
              projects={projects}
              showCompleted={showCompleted}
              assignedOnly={scope === 'assigned'}
              onOpenIssue={openIssue}
              selectedIssue={selected?.issue}
              onOpenProject={onOpenProject}
              active={active}
              onOpenTask={(issue, binding) =>
                openIssue(issue, { key: crypto.randomUUID(), binding })
              }
              order={order}
            />
          ) : null}
          {!archived && state.hasMore ? (
            <ControlButton
              variant="unstyled"
              type="button"
              disabled={state.loading}
              data-testid="personal-issues-load-more"
              onClick={() => void state.loadMore()}
              className="min-h-11 rounded-md px-3 text-sm text-text-secondary hover:bg-muted md:min-h-8"
            >
              {t('personalHome.loadMore')}
            </ControlButton>
          ) : null}
        </div>
      </main>
      {selected && project ? (
        <div
          className={`relative flex min-h-0 min-w-0 shrink-0 flex-col border-l border-border ${expanded || detailExpanded ? 'w-[min(75%,72rem)]' : 'w-[min(44%,32rem)]'}`}
          data-testid="personal-issues-detail"
        >
          {renderIssueDetail({
            presentation: 'drawer',
            onExpandedChange: setExpanded,
            detailExpanded,
            onDetailExpandedChange: setDetailExpanded,
            issue: selected.issue,
            project,
            active,
            taskRequest: selected.taskRequest,
            onClose: () => setSelected(undefined),
            onUpdated: issue => {
              state.replaceIssue(issue)
              setSelected(current => (current ? { ...current, issue } : current))
            },
            onOpenIssue: issue => openIssue({ ...selected.issue, ...issue }),
            onOpenInProject: () => onOpenIssue(selected.issue),
          })}
        </div>
      ) : null}
      {independentId && independent?.api ? (
        <IndependentIssueDialog
          key={independentId}
          api={independent.api}
          collaborationApi={independent.collaborationApi}
          expanded={detailExpanded}
          onExpandedChange={setDetailExpanded}
          userId={independent.userId}
          issueId={independentId}
          presentation="drawer"
          onClose={() => setIndependentId(undefined)}
          onSaved={issue => {
            independentPage.reload()
            if (!issue) setIndependentId(undefined)
          }}
          onOpenProjectIssue={(projectId, issueId) => {
            const project = projects.find(project => project.id === projectId)
            if (project)
              onOpenIssue({ id: issueId, cloud_project_id: projectId } as WorkspaceMyWorkItem)
          }}
        />
      ) : null}
    </div>
  )
}
