import type { CollaborationIssue, CollaborationProject } from '../types'
import type {
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
  WorkspaceRuntimeTaskAddress,
  WorkspaceTaskBinding,
} from '../ports/SharedWorkspaceApi'
import { Checkbox } from '../controls/Checkbox'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { normalizeSelectValue } from '../controls/selectValue'
import { Button as ControlButton } from '../markdown/Button'
import type { ComponentProps, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { IssueDetailDraftProvider } from '../issue-detail/IssueDetailDraft'
import { PersonalHome } from './PersonalHome'
import type { CollaborationPlatformHostAdapter } from './types'
import { PersonalIssueErrors } from './PersonalIssueErrors'
import { PersonalIssueList } from './PersonalIssueList'
import { usePersonalIssueSources, type UnassignedIssueSource } from './usePersonalIssueSources'
import { usePersonalHomeIssues, type PersonalHomeIssueOrder } from './usePersonalHomeIssues'
import type { SubscribePersonalIssueChanges } from './personalHomeIssuesSource'
import type { IndependentIssue } from './personalIssuesApi'

export interface PersonalHomeIssueDetailContext {
  presentation?: 'drawer'
  issue: WorkspaceMyWorkItem
  project: CollaborationProject
  active: boolean
  onUpdated(issue: WorkspaceMyWorkItem): void
  onOpenIssue(issue: CollaborationIssue): void
  onClose?(): void
  onExpandedChange?(expanded: boolean): void
  detailExpanded?: boolean
  onDetailExpandedChange?(expanded: boolean): void
  onOpenInProject?(): void
  taskRequest?: {
    key: string
    binding?: WorkspaceTaskBinding
    address?: WorkspaceRuntimeTaskAddress
  }
}

type IndependentIssueDrawerProps = {
  issueId: string
  expanded: boolean
  onExpandedChange(expanded: boolean): void
  onClose(): void
  onSaved(issue: IndependentIssue | null): void
  onOpenChildTask(issue: CollaborationIssue): void
  onOpenProjectIssue(projectId: string, issueId: string): void
}

export function PersonalIssuesView({
  scope,
  home,
  sources,
  projects,
  userId,
  localUserIds,
  active,
  onOpenIssue,
  onOpenProject,
  renderIssueDetail,
  independent,
  language,
  translate: t,
  renderActivity,
  renderIndependentIssue,
  independentSelection,
  subscribeChanges,
}: {
  scope: 'home' | 'assigned' | 'created' | 'participating'
  home?: Parameters<NonNullable<CollaborationPlatformHostAdapter['renderPersonalHome']>>[0]
  sources: SharedWorkspaceApi[]
  projects: CollaborationProject[]
  userId: number
  localUserIds?: readonly (string | number)[]
  active: boolean
  onOpenIssue(issue: WorkspaceMyWorkItem): void
  onOpenProject(project: CollaborationProject): void
  renderIssueDetail?(context: PersonalHomeIssueDetailContext): ReactNode
  independent: (UnassignedIssueSource & { create?(): void }) | null
  language: string
  translate(key: string, options?: Record<string, string | number>): string
  renderActivity?: ComponentProps<typeof PersonalIssueList>['renderActivity']
  renderIndependentIssue?(props: IndependentIssueDrawerProps): ReactNode
  independentSelection?: { id?: string; select(id?: string): void }
  subscribeChanges?: SubscribePersonalIssueChanges
}) {
  const composerRegion = useRef<HTMLDivElement>(null)
  const [homeAssignedOnly, setHomeAssignedOnly] = useState(true)
  const assignedOnly = scope === 'home' ? homeAssignedOnly : scope === 'assigned'
  const [archived, setArchived] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [order, setOrder] = useState<PersonalHomeIssueOrder>('attention')
  const [expanded, setExpanded] = useState(false)
  const [detailExpanded, setDetailExpanded] = useState(false)
  const [selected, setSelected] = useState<{
    issue: WorkspaceMyWorkItem
    taskRequest?: PersonalHomeIssueDetailContext['taskRequest']
  }>()
  const [localIndependentId, setLocalIndependentId] = useState<string>()
  const independentId = independentSelection ? independentSelection.id : localIndependentId
  const setIndependentId = independentSelection?.select ?? setLocalIndependentId
  const [detailScope, setDetailScope] = useState({ userId, sources })
  if (
    detailScope.userId !== userId ||
    detailScope.sources.length !== sources.length ||
    detailScope.sources.some((source, index) => source !== sources[index])
  ) {
    setDetailScope({ userId, sources })
    setSelected(undefined)
    setLocalIndependentId(undefined)
    setExpanded(false)
  }
  const [recentCreation, setRecentCreation] = useState<{
    key: string
    issue: WorkspaceMyWorkItem
    assignedOnly: boolean
    order: PersonalHomeIssueOrder
  }>()
  const created = home?.createdIssue
  if (created && renderIssueDetail && recentCreation?.key !== created.key) {
    setRecentCreation({ key: created.key, issue: created.issue, assignedOnly, order })
    setSelected({
      issue: created.issue,
      taskRequest: created.task ? { key: created.key, address: created.task } : undefined,
    })
  }
  const workSources = usePersonalIssueSources(sources, independent, archived)
  const state = usePersonalHomeIssues(
    workSources,
    active,
    assignedOnly,
    showCompleted,
    localUserIds ?? [userId],
    order,
    scope === 'home' ? undefined : scope,
    home?.createdIssue
      ? { key: home.createdIssue.key, onHandled: home.onCreatedIssueHandled }
      : undefined,
    subscribeChanges
  )
  const project = projects.find(project => project.id === selected?.issue.cloud_project_id)
  const openIssue = (
    issue: WorkspaceMyWorkItem,
    taskRequest?: PersonalHomeIssueDetailContext['taskRequest']
  ) => {
    if (issue.can_view_detail === false) return
    if (!renderIssueDetail) {
      onOpenIssue(issue)
      return
    }
    if (independentId) setIndependentId(undefined)
    setSelected({ issue, taskRequest })
  }
  const list: ComponentProps<typeof PersonalIssueList> = {
    userId,
    localUserIds,
    state,
    unassignedUserId: independent?.userId,
    projects: archived ? [] : projects,
    showCompleted,
    assignedOnly,
    onOpenIssue: issue => {
      if (issue.cloud_project_id) openIssue(issue)
      else {
        setSelected(undefined)
        setIndependentId(issue.id)
      }
    },
    selectedIssue: independentId ? { id: independentId, cloud_project_id: '' } : selected?.issue,
    recentIssue:
      recentCreation?.assignedOnly === assignedOnly && recentCreation.order === order
        ? recentCreation.issue
        : undefined,
    onOpenProject,
    active,
    onOpenTask: (issue, binding) => openIssue(issue, { key: crypto.randomUUID(), binding }),
    order,
    language,
    translate: t,
    renderActivity,
  }
  const detailOpen = Boolean(independentId || selected)
  return (
    <IssueDetailDraftProvider scope={sources[0]}>
      <div
        className="issue-drawer-workspace relative flex h-full min-h-0 min-w-0 flex-1"
        data-testid={home ? 'personal-home' : undefined}
      >
        {home ? (
          <PersonalHome
            list={list}
            subtitle={t('personalHome.webSubtitle')}
            createIssue={home.createIssue}
            composerRegion={composerRegion}
            focusComposer={() => {
              const region = composerRegion.current
              const input = region?.querySelector<HTMLElement>(
                '[data-testid="collaboration-home-issue-content"]'
              )
              const create = region?.querySelector<HTMLButtonElement>(
                '[data-testid="collaboration-first-issue-create"]'
              )
              const target = input ?? create
              target?.focus()
            }}
            firstUse={!projects.length && !independent?.api}
            hideOnMobile={detailOpen}
            scrollOnMobile
            setAssignedOnly={setHomeAssignedOnly}
            setShowCompleted={setShowCompleted}
            setOrder={setOrder}
          />
        ) : (
          <main
            className={`min-h-0 min-w-0 flex-1 overflow-auto p-4 lg:p-5 ${independentId || selected ? 'max-md:hidden' : ''}`}
            data-testid={`personal-issues-${scope}`}
          >
            <div className="mx-auto w-full max-w-6xl">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-heading-md font-medium">{t(`personalIssues.${scope}`)}</h1>
                {independent?.create ? (
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
              <p className="mt-2 text-base text-text-secondary">
                {t(`personalIssues.${scope}Hint`)}
              </p>
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
                    if (selectedValue !== null)
                      return setOrder(selectedValue as PersonalHomeIssueOrder)
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
              <PersonalIssueErrors state={state} translate={t} />
              <PersonalIssueList
                {...list}
                hideEmpty={archived && !independent?.api}
                showUnassignedEmpty={archived && Boolean(independent?.api)}
              />
              {state.hasMore ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  disabled={!state.canLoadMore}
                  data-testid="personal-issues-load-more"
                  onClick={() => void state.loadMore()}
                  className="min-h-11 rounded-md px-3 text-sm text-text-secondary hover:bg-muted md:min-h-8"
                >
                  {t('personalHome.loadMore')}
                </ControlButton>
              ) : null}
            </div>
          </main>
        )}
        {(selected && project && renderIssueDetail) ||
        (independentId && independent?.api && renderIndependentIssue) ? (
          <div
            className={`collaboration-personal-home-detail relative flex min-h-0 min-w-0 shrink-0 flex-col border-l border-border ${expanded || detailExpanded ? 'w-full md:w-[min(75%,72rem)]' : 'w-full md:w-[min(44%,32rem)]'}`}
            data-testid="personal-issues-detail"
          >
            {selected && project && renderIssueDetail
              ? renderIssueDetail({
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
                    setSelected(current =>
                      current?.issue.id === issue.id ? { ...current, issue } : current
                    )
                  },
                  onOpenIssue: issue => openIssue({ ...selected.issue, ...issue }),
                  onOpenInProject: () => onOpenIssue(selected.issue),
                })
              : independentId &&
                renderIndependentIssue?.({
                  issueId: independentId,
                  expanded: detailExpanded,
                  onExpandedChange: setDetailExpanded,
                  onClose: () => setIndependentId(undefined),
                  onOpenChildTask: issue => setIndependentId(issue.id),
                  onSaved: issue => {
                    state.reload()
                    if (!issue) setIndependentId(undefined)
                  },
                  onOpenProjectIssue: (projectId, issueId) => {
                    const project = projects.find(project => project.id === projectId)
                    if (project)
                      onOpenIssue({
                        id: issueId,
                        cloud_project_id: projectId,
                      } as WorkspaceMyWorkItem)
                  },
                })}
          </div>
        ) : null}
      </div>
    </IssueDetailDraftProvider>
  )
}
