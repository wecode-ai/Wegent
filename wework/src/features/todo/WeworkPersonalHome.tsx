import { IndependentIssueDialog } from './IndependentIssueDialog'
import { revealWorkspaceTab } from '@/components/layout/workspace-panels/revealWorkspaceTab'
import { WorkspaceTitleTab } from '@/components/layout/workspace-panels/WorkspaceTitleTab'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
  WorkspaceRuntimeTaskAddress,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import {
  IssueDetailDraftProvider,
  issueNeedsUser,
  pendingIssueHumanRequests,
} from '@wegent/collaboration'
import { TabsList, TabsRoot } from '@wegent/collaboration/controls/Tabs'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ArrowLeft, Circle, PanelRightClose, PanelRightOpen, UserRound } from 'lucide-react'
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { PersonalHomeIssueActivity } from './PersonalHomeIssueActivity'
import { PersonalHome, usePersonalIssueSources } from '@wegent/collaboration/platform'
import { useIndependentIssues } from './independentIssuesContext'
import { usePersonalHomeIssues, type PersonalHomeIssueOrder } from './usePersonalHomeIssues'

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

export interface PersonalHomeCollaborationWork {
  pendingIssues: WorkspaceMyWorkItem[]
  onOpenIssue(issue: WorkspaceMyWorkItem): void
}

const issueTabId = (project: CollaborationProject, issue: WorkspaceMyWorkItem) =>
  `${project.project_store}:${project.id}:${issue.id}`

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
  onOpenProjectIssue,
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
  onOpenProjectIssue?(projectId: string, issueId: string): void
  conversation(active: boolean, work: PersonalHomeCollaborationWork): ReactNode
}) {
  const { t, i18n } = useTranslation('common')
  const isDesktop = useIsDesktop(1024)
  const panelId = useId()
  const composerRegion = useRef<HTMLDivElement>(null)
  const composerFocusTarget = useMemo(
    () => ({
      get current() {
        const region = composerRegion.current
        const taskMode = region?.querySelector(
          '[data-testid="personal-home-new-issue"][aria-selected="true"]'
        )
        return (
          region?.querySelector<HTMLElement>(
            taskMode
              ? '[data-testid="personal-home-task-content"]'
              : '[data-testid="collaboration-home-issue-content"]'
          ) ?? null
        )
      },
    }),
    []
  )
  const focusComposer = useCallback(
    () => composerFocusTarget.current?.focus(),
    [composerFocusTarget]
  )
  useFocusRequest(composerFocusTarget, entryRequestKey, { enabled: Boolean(entryRequestKey) })
  const [showCompleted, setShowCompleted] = useState(false)
  const [assignedOnly, setAssignedOnly] = useState(true)
  const [order, setOrder] = useState<PersonalHomeIssueOrder>('attention')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const sidebarVisible = !isDesktop || !sidebarCollapsed
  const [issueTabs, setIssueTabs] = useState<
    Array<
      | {
          id: string
          issue: WorkspaceMyWorkItem
          project: CollaborationProject
          taskRequest?: PersonalHomeIssueDetailContext['taskRequest']
        }
      | { id: string; issue: WorkspaceMyWorkItem; project: null }
    >
  >([])
  const [activeTab, setActiveTab] = useState('stand-in')
  const viewport = useRef<HTMLDivElement>(null)
  const sidebar = useRef<HTMLElement>(null)
  const [workspaceFocus, setWorkspaceFocus] = useState<{
    target: 'detail' | 'list'
    captureList?: boolean
  } | null>(null)
  const handledWorkspaceFocus = useRef<typeof workspaceFocus>(null)
  const listPosition = useRef(0)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [detailExpanded, setDetailExpanded] = useState(false)
  const [expandedTabs, setExpandedTabs] = useState<ReadonlySet<string>>(new Set())
  const tabsViewport = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    revealWorkspaceTab(tabsViewport.current)
  }, [activeTab, issueTabs.length])
  useLayoutEffect(() => {
    const root = viewport.current
    const panel = sidebar.current
    if (!workspaceFocus || handledWorkspaceFocus.current === workspaceFocus) return
    handledWorkspaceFocus.current = workspaceFocus
    if (isDesktop || !root || !panel) return
    if (workspaceFocus.target === 'detail') {
      if (workspaceFocus.captureList) {
        listPosition.current = root.scrollTop
        returnFocus.current = root.querySelector<HTMLElement>('[aria-current="true"] button')
      }
      root.scrollTop += panel.getBoundingClientRect().top - root.getBoundingClientRect().top
      panel
        .querySelector<HTMLElement>('[role="tabpanel"]:not([inert])')
        ?.focus({ preventScroll: true })
    } else {
      root.scrollTop = listPosition.current
      const list = composerRegion.current?.closest('section')
      const target = returnFocus.current?.isConnected ? returnFocus.current : list
      target?.focus({ preventScroll: true })
    }
  }, [workspaceFocus, isDesktop])
  const independent = useIndependentIssues()
  const workSources = usePersonalIssueSources(sources, independent)
  const activeIssueTab = issueTabs.find(tab => tab.id === activeTab)
  const changeTabExpansion = (id: string, expanded: boolean) =>
    setExpandedTabs(current => {
      if (current.has(id) === expanded) return current
      const next = new Set(current)
      if (expanded) next.add(id)
      else next.delete(id)
      return next
    })
  const state = usePersonalHomeIssues(
    workSources,
    active,
    assignedOnly,
    showCompleted,
    localUserIds ?? [userId],
    order,
    undefined,
    createdIssue ? { key: createdIssue.key, onHandled: onCreatedIssueHandled } : undefined
  )
  const openIssue = (
    issue: CollaborationIssue,
    taskRequest?: PersonalHomeIssueDetailContext['taskRequest'],
    captureList = false
  ) => {
    const project = projects.find(project => project.id === issue.cloud_project_id)
    if (!project && issue.cloud_project_id) return
    const summary: WorkspaceMyWorkItem = {
      project_name: project?.name ?? '',
      project_key: project?.project_key ?? '',
      has_active_task: false,
      ...issue,
    }
    const id = project ? issueTabId(project, summary) : `independent:${issue.id}`
    setIssueTabs(tabs =>
      tabs.some(tab => tab.id === id)
        ? tabs.map(tab =>
            tab.project && tab.id === id && taskRequest ? { ...tab, taskRequest } : tab
          )
        : project
          ? [{ id, issue: summary, project, taskRequest }]
          : [{ id, issue: summary, project: null }]
    )
    setExpandedTabs(current => (current.has(id) ? current : new Set()))
    setSidebarCollapsed(false)
    setWorkspaceFocus({ target: 'detail', captureList })
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
    setWorkspaceFocus(null)
    setActiveTab('stand-in')
    setExpandedTabs(new Set())
    setRecentCreation(undefined)
  }
  if (createdIssue && createdIssue.key !== handledCreation) {
    setWorkspaceFocus({ target: 'detail', captureList: true })
    setSidebarCollapsed(false)
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
  const closeIssue = (id: string) => {
    const index = issueTabs.findIndex(tab => tab.id === id)
    const remaining = issueTabs.filter(tab => tab.id !== id)
    setIssueTabs(remaining)
    if (activeTab === id) {
      const next = remaining[Math.max(0, index - 1)]?.id ?? 'stand-in'
      setActiveTab(next)
      setWorkspaceFocus({ target: next === 'stand-in' ? 'list' : 'detail' })
    }
  }
  const firstUse = !projects.length && !independent?.api
  return (
    <IssueDetailDraftProvider key={userId} scope={draftScope}>
      <div
        ref={viewport}
        className="isolate flex h-full min-h-0 flex-col overflow-auto lg:flex-row lg:overflow-hidden"
        data-testid="personal-home"
      >
        <PersonalHome
          composerRegion={composerRegion}
          focusComposer={focusComposer}
          createIssue={createIssue}
          firstUse={firstUse}
          setAssignedOnly={setAssignedOnly}
          setShowCompleted={setShowCompleted}
          setOrder={setOrder}
          headerAction={
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="personal-home-toggle-sidebar"
              aria-expanded={!sidebarCollapsed}
              aria-controls={`${panelId}-sidebar`}
              onClick={() => setSidebarCollapsed(value => !value)}
              className="hidden h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-text-secondary hover:bg-muted keyboard:focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-[color-mix(in_srgb,rgb(var(--color-focus-ring))_80%,rgb(var(--color-text-primary))_20%)] lg:inline-flex"
            >
              {sidebarCollapsed ? (
                <PanelRightOpen aria-hidden="true" className="h-4 w-4" />
              ) : (
                <PanelRightClose aria-hidden="true" className="h-4 w-4" />
              )}
              {t(sidebarCollapsed ? 'personalHome.showSidebar' : 'personalHome.hideSidebar')}
            </ControlButton>
          }
          list={{
            userId,
            localUserIds,
            projects,
            state,
            showCompleted,
            assignedOnly,
            order,
            active,
            unassignedUserId: independent?.userId,
            selectedIssue: activeIssueTab?.issue,
            onOpenIssue: issue => openIssue(issue, undefined, true),
            onOpenTask: (issue, binding) =>
              openIssue(issue, { key: crypto.randomUUID(), binding }, true),
            renderActivity: props => <PersonalHomeIssueActivity {...props} />,
            translate: t,
            language: i18n.language,
            recentIssue:
              recentCreation &&
              recentCreation.assignedOnly === assignedOnly &&
              recentCreation.order === order
                ? issueTabs.find(
                    (
                      tab
                    ): tab is Extract<
                      (typeof issueTabs)[number],
                      { project: CollaborationProject }
                    > =>
                      tab.project !== null &&
                      tab.issue.id === recentCreation.issueId &&
                      tab.issue.cloud_project_id === recentCreation.projectId
                  )?.issue
                : undefined,
          }}
        />
        <aside
          ref={sidebar}
          id={`${panelId}-sidebar`}
          aria-label={t('personalHome.standIn')}
          className={`flex ${!isDesktop && activeTab !== 'stand-in' ? 'min-h-full' : 'min-h-96'} min-w-0 flex-col border-t border-border lg:h-full lg:shrink-0 lg:border-l lg:border-t-0 ${sidebarCollapsed ? 'lg:hidden' : ''} ${detailExpanded || expandedTabs.has(activeTab) ? 'lg:w-[min(75%,72rem)]' : activeTab === 'stand-in' ? 'lg:w-80 xl:w-96' : 'lg:w-96 xl:w-[28rem]'}`}
          data-testid="personal-home-stand-in"
        >
          {!isDesktop && activeTab !== 'stand-in' && (
            <ControlButton
              variant="outline"
              size="sm"
              type="button"
              data-testid="personal-home-back-to-issues"
              onClick={() => {
                setWorkspaceFocus({ target: 'list' })
                setActiveTab('stand-in')
              }}
              className="flex min-h-11 items-center gap-2 border-b border-border px-3 text-sm text-text-secondary hover:bg-muted"
            >
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              {t('personalHome.backToIssues')}
            </ControlButton>
          )}
          <TabsRoot
            value={`${panelId}-${activeTab}-tab`}
            onValueChange={next => {
              if (next === `${panelId}-stand-in-tab`) {
                setWorkspaceFocus(null)
                setActiveTab('stand-in')
                return
              }
              const tab = issueTabs.find(tab => `${panelId}-${tab.id}-tab` === next)
              if (tab) {
                setWorkspaceFocus(null)
                setActiveTab(tab.id)
              }
            }}
            render={<div className="contents" />}
          >
            <TabsList
              ref={tabsViewport}
              aria-label={t('personalHome.workspaceTabs')}
              data-testid="personal-home-tabs"
              className="flex h-12 min-h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-3 lg:h-10 lg:min-h-10"
            >
              <WorkspaceTitleTab
                id={`${panelId}-stand-in-tab`}
                controls={`${panelId}-stand-in-panel`}
                testId="personal-home-tab-stand-in"
                active={activeTab === 'stand-in'}
                label={t('personalHome.standInTab')}
                icon={<UserRound aria-hidden="true" className="h-4 w-4" />}
                onSelect={() => {
                  setWorkspaceFocus(null)
                  setActiveTab('stand-in')
                }}
              />
              {issueTabs.map(tab => (
                <WorkspaceTitleTab
                  id={`${panelId}-${tab.id}-tab`}
                  controls={`${panelId}-${tab.id}-panel`}
                  key={tab.id}
                  testId={`personal-home-tab-${tab.issue.id}`}
                  active={activeTab === tab.id}
                  label={tab.issue.title}
                  title={
                    tab.project
                      ? `${tab.project.name} · #${tab.issue.sequence_number} ${tab.issue.title}`
                      : tab.issue.title
                  }
                  icon={<Circle aria-hidden="true" className="h-4 w-4" />}
                  onSelect={() => {
                    setWorkspaceFocus(null)
                    setActiveTab(tab.id)
                  }}
                  onClose={() => closeIssue(tab.id)}
                />
              ))}
            </TabsList>
          </TabsRoot>
          <div
            id={`${panelId}-stand-in-panel`}
            role="tabpanel"
            aria-labelledby={`${panelId}-stand-in-tab`}
            aria-label={t('personalHome.standInTab')}
            className={activeTab === 'stand-in' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
            inert={activeTab !== 'stand-in'}
          >
            {conversation(active && sidebarVisible && activeTab === 'stand-in', {
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
              tabIndex={-1}
              className={activeTab === tab.id ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
              inert={activeTab !== tab.id}
            >
              {tab.project ? (
                renderIssueDetail({
                  issue: tab.issue,
                  project: tab.project,
                  active: active && sidebarVisible && activeTab === tab.id,
                  taskRequest: tab.taskRequest,
                  detailExpanded,
                  onDetailExpandedChange: setDetailExpanded,
                  onClose: () => closeIssue(tab.id),
                  onExpandedChange: expanded => changeTabExpansion(tab.id, expanded),
                  onOpenIssue: openIssue,
                  onUpdated: issue => {
                    state.replaceIssue(issue)
                    setIssueTabs(tabs =>
                      tabs.map(current =>
                        current.project && current.id === tab.id ? { ...current, issue } : current
                      )
                    )
                  },
                })
              ) : independent?.api ? (
                <IndependentIssueDialog
                  api={independent.api}
                  collaborationApi={independent.collaborationApi}
                  userId={independent.userId}
                  issueId={tab.issue.id}
                  presentation="embedded"
                  expanded={detailExpanded}
                  onExpandedChange={setDetailExpanded}
                  onConversationOpenChange={open => changeTabExpansion(tab.id, open)}
                  onClose={() => closeIssue(tab.id)}
                  onOpenChildTask={openIssue}
                  onSaved={issue => {
                    state.reload()
                    if (!issue) closeIssue(tab.id)
                    else if (issue.detail) {
                      const detail = issue.detail
                      setIssueTabs(tabs =>
                        tabs.map(current =>
                          !current.project && current.id === tab.id
                            ? { ...current, issue: { ...current.issue, ...detail } }
                            : current
                        )
                      )
                    }
                  }}
                  onOpenProjectIssue={onOpenProjectIssue}
                />
              ) : null}
            </div>
          ))}
        </aside>
      </div>
    </IssueDetailDraftProvider>
  )
}
