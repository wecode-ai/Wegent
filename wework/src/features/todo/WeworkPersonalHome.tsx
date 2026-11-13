import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, Circle, FolderOpen, UserRound } from 'lucide-react'
import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
  WorkspaceTaskBinding,
  WorkspaceRuntimeTaskAddress,
} from '@wegent/collaboration'
import {
  CollaborationIssueCard,
  createCollaborationTranslator,
  createIssueBoardCardLabels,
  issueNeedsUser,
  pendingIssueHumanRequests,
  IssueDetailDraftProvider,
} from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { PersonalHomeIssueActivity } from './PersonalHomeIssueActivity'
import { usePersonalHomeIssues, type PersonalHomeIssueOrder } from './usePersonalHomeIssues'
import { personalHomeAssignmentAt, personalHomeAssignmentDuration } from './personalHomeAssignment'
import { useSidebarRelativeTimeRefresh } from '@/components/layout/runtimeSidebarTime'
import { WorkspaceTitleTab } from '@/components/layout/workspace-panels/WorkspaceTitleTab'
import { revealWorkspaceTab } from '@/components/layout/workspace-panels/revealWorkspaceTab'

export interface PersonalHomeIssueDetailContext {
  issue: WorkspaceMyWorkItem
  project: CollaborationProject
  active: boolean
  onUpdated(issue: WorkspaceMyWorkItem): void
  onOpenIssue(issue: CollaborationIssue): void
  onClose?(): void
  onExpandedChange?(expanded: boolean): void
  onOpenInProject?(): void
  taskRequest?: {
    key: string
    binding?: WorkspaceTaskBinding
    address?: WorkspaceRuntimeTaskAddress
  }
}

export interface PersonalHomeCollaborationWork {
  pendingIssues: WorkspaceMyWorkItem[]
  onOpenIssue(issue: WorkspaceMyWorkItem): void
}

const issueTabId = (project: CollaborationProject, issue: WorkspaceMyWorkItem) =>
  `${project.project_store}:${project.id}:${issue.id}`

function PersonalIssueList({
  userId,
  localUserIds,
  state,
  projects,
  showCompleted,
  assignedOnly,
  onOpenIssue,
  active,
  onOpenTask,
  recentIssue,
  order,
}: {
  userId: number
  localUserIds?: readonly (string | number)[]
  active: boolean
  onOpenTask(issue: WorkspaceMyWorkItem, binding: WorkspaceTaskBinding): void
  recentIssue?: WorkspaceMyWorkItem
  order: PersonalHomeIssueOrder
  state: ReturnType<typeof usePersonalHomeIssues>
  projects: CollaborationProject[]
  showCompleted: boolean
  assignedOnly: boolean
  onOpenIssue(issue: WorkspaceMyWorkItem): void
}) {
  const { t, i18n } = useTranslation('common')
  useSidebarRelativeTimeRefresh(active)
  const recentCard = useRef<HTMLElement>(null)
  const revealedIssue = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!recentIssue || !recentCard.current || revealedIssue.current === recentIssue.id) return
    revealedIssue.current = recentIssue.id
    recentCard.current.scrollIntoView?.({ block: 'nearest' })
    recentCard.current.animate?.(
      [
        { backgroundColor: 'color-mix(in srgb, currentColor 8%, transparent)' },
        { backgroundColor: 'transparent' },
      ],
      { duration: 1600 }
    )
  }, [recentIssue])
  const labels = createIssueBoardCardLabels(
    createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')
  )
  const visibleItems = recentIssue
    ? [
        state.items.find(
          item =>
            item.id === recentIssue.id && item.cloud_project_id === recentIssue.cloud_project_id
        ) ?? recentIssue,
        ...state.items.filter(
          item =>
            item.id !== recentIssue.id || item.cloud_project_id !== recentIssue.cloud_project_id
        ),
      ]
    : state.items
  const compareItems = (left: WorkspaceMyWorkItem, right: WorkspaceMyWorkItem) => {
    if (left.id === right.id && left.cloud_project_id === right.cloud_project_id) return 0
    if (left.id === recentIssue?.id) return -1
    if (right.id === recentIssue?.id) return 1
    const a = left.attention_order
    const b = right.attention_order
    return (
      (a?.[0] ?? 3) - (b?.[0] ?? 3) ||
      (a?.[1] ?? 4) - (b?.[1] ?? 4) ||
      ((Date.parse(b?.[2] ?? right.updated_at) || 0) -
        (Date.parse(a?.[2] ?? left.updated_at) || 0)) *
        (order === 'assignment' ? -1 : 1) ||
      right.id.localeCompare(left.id)
    )
  }
  const orderedItems = [...visibleItems].sort(compareItems)
  const itemsByProject = new Map<string, WorkspaceMyWorkItem[]>()
  for (const item of orderedItems) {
    const key = String(item.cloud_project_id)
    const items = itemsByProject.get(key) ?? []
    items.push(item)
    itemsByProject.set(key, items)
  }
  const groups = projects
    .map(project => ({
      project,
      items: (itemsByProject.get(String(project.id)) ?? []).filter(
        item =>
          String(item.cloud_project_id) === String(project.id) &&
          (!assignedOnly ||
            (item.assignee_user_id != null &&
              (project.project_store === 'local'
                ? (localUserIds ?? [userId])
                : [project.current_user_id ?? userId]
              ).some(id => String(item.assignee_user_id) === String(id)))) &&
          !item.archived_at &&
          (showCompleted || !['completed', 'cancelled'].includes(item.status))
      ),
    }))
    .filter(group => group.items.length)
    .sort(
      (left, right) =>
        Number(right.project.id === recentIssue?.cloud_project_id) -
          Number(left.project.id === recentIssue?.cloud_project_id) ||
        (order === 'attention'
          ? Number(right.items.some(item => item.attention_order?.[0] === 0)) -
            Number(left.items.some(item => item.attention_order?.[0] === 0))
          : compareItems(left.items[0], right.items[0]))
    )
  return (
    <>
      {state.loading && (
        <p role="status" className="py-4 text-sm text-text-muted">
          {t('personalHome.loading')}
        </p>
      )}
      {state.error && (
        <div role="alert" className="flex items-center gap-2 py-4 text-sm text-error">
          {t('personalHome.loadFailed')}
          <button
            type="button"
            data-testid="personal-home-retry"
            className="min-h-11 underline md:min-h-8"
            onClick={state.reload}
          >
            {t('standIn.reload')}
          </button>
        </div>
      )}
      {!state.loading && !state.error && !groups.length && (
        <p className="py-8 text-sm text-text-muted">{t('personalHome.empty')}</p>
      )}
      {groups.map(({ project, items }) => (
        <section
          key={project.id}
          className="mb-6"
          data-testid={`personal-home-project-${project.id}`}
        >
          <h3 className="mb-1 flex items-center gap-2 text-base font-medium text-text-secondary">
            <FolderOpen aria-hidden="true" className="h-4 w-4 text-text-muted" />
            {project.name}
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-text-muted">
              {items.length}
            </span>
          </h3>
          {items.map(item => {
            const viewerIds =
              project.project_store === 'local'
                ? (localUserIds ?? [userId])
                : [project.current_user_id ?? userId]
            const assignedAt = personalHomeAssignmentAt(item, viewerIds)
            const waiting =
              pendingIssueHumanRequests(item).length > 0 && issueNeedsUser(item, viewerIds)
            const currentAssignee =
              item.assignee_user_id != null &&
              viewerIds.some(id => String(id) === String(item.assignee_user_id))
            const configuredStatus = project.board_config?.statuses.find(
              status => status.id === item.status
            )?.name
            const status = waiting
              ? t('personalHome.needsInput')
              : (configuredStatus ?? t(`todo.status_${item.status}`, { defaultValue: item.status }))
            return (
              <CollaborationIssueCard
                variant="list"
                cardRef={item.id === recentIssue?.id ? recentCard : undefined}
                key={item.id}
                item={
                  currentAssignee && !item.assignee_name
                    ? { ...item, assignee_name: t('personalHome.me') }
                    : item
                }
                reference={`#${item.sequence_number}`}
                labels={{
                  ...labels,
                  statuses: {
                    ...labels.statuses,
                    ...Object.fromEntries(
                      (project.board_config?.statuses ?? []).map(status => [status.id, status.name])
                    ),
                  },
                }}
                display={{
                  showAssignee: true,
                  showDate: false,
                  showPriority: true,
                  showTags: true,
                }}
                detailButtonTestId={`personal-home-issue-${item.id}`}
                cardClassName="cursor-pointer focus-within:bg-text-primary/[0.025]"
                detailButtonClassName="cursor-pointer keyboard:focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30"
                onOpen={() => onOpenIssue(item)}
                titleTrailing={
                  waiting ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-normal text-amber-700 dark:text-amber-400">
                      <Bell aria-hidden="true" className="h-3.5 w-3.5" />
                      {status}
                    </span>
                  ) : undefined
                }
                summary={
                  <>
                    <PersonalHomeIssueActivity
                      summary={
                        <>
                          {assignedAt && (
                            <p
                              data-testid={`personal-home-assignment-age-${item.id}`}
                              title={new Date(assignedAt).toLocaleString(i18n.language)}
                              className="mb-1 text-xs text-text-muted"
                            >
                              {t('personalHome.assignedFor', {
                                duration: personalHomeAssignmentDuration(assignedAt, i18n.language),
                              })}
                            </p>
                          )}
                          {item.description ? (
                            <p className="line-clamp-2 max-w-3xl whitespace-pre-wrap text-base leading-6 text-text-secondary">
                              {item.description}
                            </p>
                          ) : undefined}
                        </>
                      }
                      assignment={item.assignment_context}
                      bindings={item.task_bindings}
                      onOpenTask={binding => onOpenTask(item, binding)}
                      issueId={item.id}
                      active={active}
                    />
                  </>
                }
              />
            )
          })}
        </section>
      ))}
    </>
  )
}

export function WeworkPersonalHome({
  active = true,
  entryRequestKey,
  userId,
  localUserIds,
  projects,
  sources,
  draftScope = sources,
  createIssue,
  renderIssueDetail,
  conversation,
  createdIssue,
  onCreatedIssueHandled,
}: {
  active?: boolean
  entryRequestKey?: number
  userId: number
  localUserIds?: readonly (string | number)[]
  projects: CollaborationProject[]
  sources: SharedWorkspaceApi[]
  draftScope?: unknown
  createIssue: ReactNode
  createdIssue?: {
    key: string
    issue: WorkspaceMyWorkItem
    project: CollaborationProject
    task?: WorkspaceRuntimeTaskAddress
  }
  onCreatedIssueHandled?(key: string): void
  renderIssueDetail(context: PersonalHomeIssueDetailContext): ReactNode
  conversation(active: boolean, work: PersonalHomeCollaborationWork): ReactNode
}) {
  const { t } = useTranslation('common')
  const panelId = useId()
  const composerRegion = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (entryRequestKey)
      composerRegion.current
        ?.querySelector<HTMLElement>('[data-testid="collaboration-home-issue-content"]')
        ?.focus()
  }, [entryRequestKey])
  const [showCompleted, setShowCompleted] = useState(false)
  const [assignedOnly, setAssignedOnly] = useState(true)
  const [order, setOrder] = useState<PersonalHomeIssueOrder>('attention')
  const [issueTabs, setIssueTabs] = useState<
    Array<{
      id: string
      issue: WorkspaceMyWorkItem
      project: CollaborationProject
      taskRequest?: PersonalHomeIssueDetailContext['taskRequest']
    }>
  >([])
  const [activeTab, setActiveTab] = useState('stand-in')
  const [expandedTabs, setExpandedTabs] = useState<ReadonlySet<string>>(new Set())
  const tabsViewport = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    revealWorkspaceTab(tabsViewport.current)
  }, [activeTab, issueTabs.length])
  const state = usePersonalHomeIssues(
    sources,
    active,
    assignedOnly,
    showCompleted,
    localUserIds ?? [userId],
    order
  )
  const openIssue = (
    issue: CollaborationIssue,
    taskRequest?: PersonalHomeIssueDetailContext['taskRequest']
  ) => {
    const project = projects.find(project => project.id === issue.cloud_project_id)
    if (!project) return
    const summary: WorkspaceMyWorkItem = {
      project_name: project.name,
      project_key: project.project_key,
      has_active_task: false,
      ...issue,
    }
    const id = issueTabId(project, summary)
    setIssueTabs(tabs =>
      tabs.some(tab => tab.id === id)
        ? tabs.map(tab => (tab.id === id && taskRequest ? { ...tab, taskRequest } : tab))
        : [{ id, issue: summary, project, taskRequest }]
    )
    setExpandedTabs(current => (current.has(id) ? current : new Set()))
    setActiveTab(id)
  }
  const [handledCreation, setHandledCreation] = useState<string>()
  const [recentCreation, setRecentCreation] = useState<{
    issueId: WorkspaceMyWorkItem['id']
    projectId: WorkspaceMyWorkItem['cloud_project_id']
    assignedOnly: boolean
    order: PersonalHomeIssueOrder
  }>()
  const [detailScope, setDetailScope] = useState({ userId, sources })
  if (
    detailScope.userId !== userId ||
    detailScope.sources.length !== sources.length ||
    detailScope.sources.some((source, index) => source !== sources[index])
  ) {
    setDetailScope({ userId, sources })
    setIssueTabs([])
    setActiveTab('stand-in')
    setExpandedTabs(new Set())
    setRecentCreation(undefined)
  }
  if (createdIssue && createdIssue.key !== handledCreation) {
    setHandledCreation(createdIssue.key)
    const ownIds =
      createdIssue.project.project_store === 'local'
        ? (localUserIds ?? [userId])
        : [createdIssue.project.current_user_id ?? userId]
    const scope =
      assignedOnly && ownIds.some(id => String(id) === String(createdIssue.issue.assignee_user_id))
    setAssignedOnly(scope)
    setRecentCreation({
      issueId: createdIssue.issue.id,
      projectId: createdIssue.issue.cloud_project_id,
      assignedOnly: scope,
      order,
    })
    const id = issueTabId(createdIssue.project, createdIssue.issue)
    setIssueTabs([
      {
        id,
        issue: createdIssue.issue,
        project: createdIssue.project,
        taskRequest: createdIssue.task
          ? { key: createdIssue.key, address: createdIssue.task }
          : undefined,
      },
    ])
    setExpandedTabs(new Set())
    setActiveTab(id)
  }
  const creationKey = createdIssue?.key
  const reloadIssues = state.reload
  useEffect(() => {
    if (creationKey) reloadIssues()
  }, [creationKey, reloadIssues])
  useEffect(() => {
    if (creationKey) onCreatedIssueHandled?.(creationKey)
  }, [creationKey, onCreatedIssueHandled])
  const closeIssue = (id: string) => {
    const index = issueTabs.findIndex(tab => tab.id === id)
    const remaining = issueTabs.filter(tab => tab.id !== id)
    setIssueTabs(remaining)
    if (activeTab === id) setActiveTab(remaining[Math.max(0, index - 1)]?.id ?? 'stand-in')
  }
  return (
    <IssueDetailDraftProvider key={userId} scope={draftScope}>
      <div
        className="flex h-full min-h-0 flex-col overflow-auto lg:flex-row lg:overflow-hidden"
        data-testid="personal-home"
      >
        <main
          aria-busy={state.loading}
          data-testid="personal-home-items-region"
          className="flex min-w-0 flex-1 flex-col p-5 lg:overflow-auto lg:p-8"
        >
          <div className="w-full max-w-6xl">
            <header className="mb-7 flex items-start justify-between gap-4">
              <div>
                <h1 className="text-heading-md font-medium">{t('personalHome.title')}</h1>
                <p className="mt-2 text-base text-text-secondary">{t('personalHome.subtitle')}</p>
              </div>
            </header>
            <div ref={composerRegion} className="mb-7" data-testid="personal-home-create">
              {createIssue}
            </div>
            <div className="mb-5 flex items-center justify-between gap-3">
              <div
                role="group"
                aria-label={t('personalHome.issueScope')}
                className="flex min-w-0 flex-wrap items-center gap-1"
              >
                {[
                  { value: true, label: 'assigned' },
                  { value: false, label: 'participating' },
                ].map(option => (
                  <button
                    type="button"
                    key={option.label}
                    data-testid={`personal-home-scope-${option.label}`}
                    aria-pressed={assignedOnly === option.value}
                    onClick={() => setAssignedOnly(option.value)}
                    className={`min-h-11 rounded-md px-3 text-base md:min-h-8 ${assignedOnly === option.value ? 'bg-muted font-medium text-text-primary' : 'text-text-secondary hover:bg-muted'}`}
                  >
                    {t(`personalHome.${option.label}`)}
                  </button>
                ))}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <select
                  aria-label={t('personalHome.sort')}
                  data-testid="personal-home-sort"
                  className="wework-native-select min-h-11 rounded-md bg-transparent px-2 text-sm text-text-secondary hover:bg-muted md:min-h-8"
                  value={order}
                  onChange={event => setOrder(event.target.value as PersonalHomeIssueOrder)}
                >
                  {(['attention', 'assignment', 'activity', 'priority'] as const).map(value => (
                    <option key={value} value={value}>
                      {t(`personalHome.sort_${value}`)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t('personalHome.filter')}
                  data-testid="personal-home-filter"
                  className="wework-native-select min-h-11 rounded-md bg-transparent px-2 text-sm md:min-h-8"
                  value={showCompleted ? 'all' : 'open'}
                  onChange={event => setShowCompleted(event.target.value === 'all')}
                >
                  <option value="open">{t('personalHome.open')}</option>
                  <option value="all">{t('personalHome.all')}</option>
                </select>
              </div>
            </div>
            <PersonalIssueList
              recentIssue={
                recentCreation &&
                recentCreation.assignedOnly === assignedOnly &&
                recentCreation.order === order
                  ? issueTabs.find(
                      tab =>
                        tab.issue.id === recentCreation.issueId &&
                        tab.issue.cloud_project_id === recentCreation.projectId
                    )?.issue
                  : undefined
              }
              order={order}
              userId={userId}
              localUserIds={localUserIds}
              state={state}
              projects={projects}
              showCompleted={showCompleted}
              assignedOnly={assignedOnly}
              onOpenIssue={openIssue}
              active={active}
              onOpenTask={(issue, binding) =>
                openIssue(issue, { key: crypto.randomUUID(), binding })
              }
            />
            {state.hasMore && (
              <button
                type="button"
                data-testid="personal-home-load-more"
                disabled={state.loading}
                onClick={() => void state.loadMore()}
                className="min-h-11 rounded-md px-3 text-sm text-text-secondary hover:bg-muted md:min-h-8"
              >
                {t('personalHome.loadMore')}
              </button>
            )}
          </div>
        </main>
        <aside
          aria-label={t('personalHome.standIn')}
          className={`flex min-h-96 min-w-0 flex-col border-t border-border lg:h-full lg:shrink-0 lg:border-l lg:border-t-0 ${expandedTabs.has(activeTab) ? 'lg:w-[min(75%,72rem)]' : 'lg:w-96 xl:w-[28rem]'}`}
          data-testid="personal-home-stand-in"
        >
          <header
            ref={tabsViewport}
            role="tablist"
            aria-label={t('personalHome.workspaceTabs')}
            data-testid="personal-home-tabs"
            className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-3"
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              const tabs = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
              )
              const index = tabs.indexOf(event.target as HTMLElement)
              if (index < 0) return
              event.preventDefault()
              const target =
                event.key === 'Home'
                  ? tabs[0]
                  : event.key === 'End'
                    ? tabs.at(-1)
                    : tabs[
                        (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
                      ]
              target?.click()
              target?.focus()
            }}
          >
            <WorkspaceTitleTab
              id={`${panelId}-stand-in-tab`}
              controls={`${panelId}-stand-in-panel`}
              testId="personal-home-tab-stand-in"
              active={activeTab === 'stand-in'}
              label={t('personalHome.standInTab')}
              icon={<UserRound aria-hidden="true" className="h-4 w-4" />}
              onSelect={() => setActiveTab('stand-in')}
            />
            {issueTabs.map(tab => (
              <WorkspaceTitleTab
                id={`${panelId}-${tab.id}-tab`}
                controls={`${panelId}-${tab.id}-panel`}
                key={tab.id}
                testId={`personal-home-tab-${tab.issue.id}`}
                active={activeTab === tab.id}
                label={tab.issue.title}
                title={`${tab.project.name} · #${tab.issue.sequence_number} ${tab.issue.title}`}
                icon={<Circle aria-hidden="true" className="h-4 w-4" />}
                onSelect={() => setActiveTab(tab.id)}
                onClose={() => closeIssue(tab.id)}
              />
            ))}
          </header>
          <div
            id={`${panelId}-stand-in-panel`}
            role="tabpanel"
            aria-labelledby={`${panelId}-stand-in-tab`}
            aria-label={t('personalHome.standInTab')}
            className={activeTab === 'stand-in' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
            inert={activeTab !== 'stand-in'}
          >
            {conversation(active && activeTab === 'stand-in', {
              pendingIssues: state.items.flatMap(item => {
                const project = projects.find(project => project.id === item.cloud_project_id)
                if (
                  !project ||
                  item.archived_at ||
                  ['completed', 'cancelled'].includes(item.status)
                )
                  return []
                const viewer =
                  project.project_store === 'local'
                    ? (localUserIds ?? [userId])
                    : (project.current_user_id ?? userId)
                const requests = pendingIssueHumanRequests(item).filter(request =>
                  issueNeedsUser({ ...item, human_requests: [request] }, viewer)
                )
                return requests.length ? [{ ...item, human_requests: requests }] : []
              }),
              onOpenIssue: openIssue,
            })}
          </div>
          {issueTabs.map(tab => (
            <div
              id={`${panelId}-${tab.id}-panel`}
              key={tab.id}
              role="tabpanel"
              aria-labelledby={`${panelId}-${tab.id}-tab`}
              aria-label={tab.issue.title}
              className={activeTab === tab.id ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
              inert={activeTab !== tab.id}
            >
              {renderIssueDetail({
                issue: tab.issue,
                project: tab.project,
                active: active && activeTab === tab.id,
                taskRequest: tab.taskRequest,
                onClose: () => closeIssue(tab.id),
                onExpandedChange: expanded =>
                  setExpandedTabs(current => {
                    if (current.has(tab.id) === expanded) return current
                    const next = new Set(current)
                    if (expanded) next.add(tab.id)
                    else next.delete(tab.id)
                    return next
                  }),
                onOpenIssue: openIssue,
                onUpdated: issue => {
                  state.replaceIssue(issue)
                  setIssueTabs(tabs =>
                    tabs.map(current => (current.id === tab.id ? { ...current, issue } : current))
                  )
                },
              })}
            </div>
          ))}
        </aside>
      </div>
    </IssueDetailDraftProvider>
  )
}
