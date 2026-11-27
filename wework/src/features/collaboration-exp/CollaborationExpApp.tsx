import { Button } from '@/components/ui/button'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { parseDingTalkAITableLink } from '@/features/todo/projectProviderConfig'
import { useCollaborationMarkdownServices } from '@/features/todo/useCollaborationMarkdownServices'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useTranslation } from '@/hooks/useTranslation'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import type { CollaborationAttachment, CollaborationView } from '@wegent/collaboration'
import {
  BrowserAttachmentPreview,
  createCollaborationTranslator,
  IssueMarkdownProvider,
  ProjectCreateDialog,
  projectCreateLabels,
} from '@wegent/collaboration'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Circle, Ellipsis, FolderKanban, Lock, Paperclip } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { AssistantTeamRelay } from './assistant'
import { CreateExperienceIssue } from './CreateExperienceIssue'
import { useExperienceIssue } from './data/useExperienceIssue'
import { useExperienceSources } from './data/useExperienceSources'
import { useExperienceTasks } from './data/useExperienceTasks'
import { useExperienceTimeline } from './data/useExperienceTimeline'
import { buildCollaborationExpRoute } from './integration/deepLinks'
import { projectScopeOf, selectProjectScopes, selectTaskRows } from './model'
import type { ExperienceProjectScope, ExperienceTaskRow } from './model/types'
import { PrivateDiscussionPane } from './private'
import { ExperiencePanes, type ExperiencePane } from './shell'
import './shell/ExperienceTheme.css'
import { ExperienceThemeProvider } from './shell/ExperienceThemeProvider'
import type { ProjectDrilldownView } from './tasks/ProjectDrilldown'
import { ProjectExperience } from './tasks/ProjectExperience'
import { ProjectHome } from './tasks/ProjectHome'
import type { TaskFilterValue } from './tasks/TaskFilters'
import { TaskHome } from './tasks/TaskHome'
import { TaskListView } from './tasks/TaskListView'
import { ExperienceIssueDetails } from './timeline/ExperienceIssueDetails'
import { ExperienceIssueSummary } from './timeline/ExperienceIssueSummary'
import { TaskTimeline, type TimelineAttachmentSelection } from './timeline/TaskTimeline'
import type { TimelineFilter } from './timeline/TimelineFilters'

const closedIssueRoute = {
  issueId: null,
  discussion: null,
  nodeId: null,
  commentId: null,
  focusRequest: null,
  inspector: null,
  timelineFilter: null,
}

export default function CollaborationExpApp({
  active = true,
  search = '',
}: {
  active?: boolean
  search?: string
}) {
  const markdownServices = useCollaborationMarkdownServices()
  return (
    <MarkdownServicesProvider value={markdownServices}>
      <ExperienceThemeProvider>
        <ExperienceContent active={active} search={search} />
      </ExperienceThemeProvider>
    </MarkdownServicesProvider>
  )
}

function ExperienceContent({ active, search }: { active: boolean; search: string }) {
  const { state, services } = useWorkbench()
  const cloud = useOptionalCloudConnection()
  const { t, i18n } = useTranslation('collaborationExp')
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const sources = useExperienceSources(services, state.user, cloud.isConnected, locale)
  const params = useMemo(() => new URLSearchParams(search), [search])
  const projectId = params.get('projectId')
  const projectStore = params.get('projectStore')
  const issueId = params.get('issueId')
  const source = sources.find(candidate => candidate.store === projectStore)
  const filters: TaskFilterValue = {
    relevance: params.get('relevance') === 'all' ? 'all' : 'related',
    search: params.get('search') ?? '',
    status: params.get('status') ?? '',
    projectKey: params.get('projectScope') ?? '',
  }
  const viewer = Number(state.user?.id)
  const viewerIds = useMemo(() => [Number(state.user?.id)], [state.user?.id])
  const tasks = useExperienceTasks(
    sources,
    viewerIds,
    active && Boolean(state.user),
    filters.relevance
  )
  const [detailRevision, setDetailRevision] = useState(0)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [createIssueOpen, setCreateIssueOpen] = useState(false)
  const projectCreateTargets = useMemo(
    () =>
      sources.map(source => ({
        location: source.store === 'local' ? ('local' as const) : ('cloud' as const),
        create: (input: Parameters<typeof source.api.projects.create>[0]) =>
          source.api.projects.create(input),
      })),
    [sources]
  )
  const detail = useExperienceIssue(
    source,
    projectId,
    issueId,
    active,
    tasks.revision + detailRevision
  )
  const stream = useExperienceTimeline(
    source?.api,
    detail.data,
    viewer,
    state.runtimeWork,
    active,
    detailRevision
  )
  const readInput = { projects: tasks.projects, viewer, runtimeWork: state.runtimeWork }
  const projectData = detail.data
    ? [
        ...tasks.projects,
        {
          project: detail.data.project,
          participationViewer: detail.data.participationViewer,
          issues: [detail.data.issue],
          taskBindings: detail.data.taskBindings,
        },
      ]
    : tasks.projects
  const projects = selectProjectScopes(readInput)
  const rows = selectTaskRows(readInput, {
    ...filters,
    statuses: filters.status ? [filters.status] : undefined,
  })
  const statuses = [
    ...new Map(
      tasks.projects.flatMap(
        row =>
          row.project.board_config?.statuses.map(
            status => [status.id, { value: status.id, label: status.name }] as const
          ) ?? []
      )
    ).values(),
  ]
  const selectedProject =
    detail.data?.project ??
    tasks.projects.find(
      row => row.project.id === projectId && row.project.project_store === projectStore
    )?.project
  const projectView = params.get('projectView')
  const projectMode: ProjectDrilldownView | null =
    projectView === 'overview' || projectView === 'plan' || projectView === 'settings'
      ? projectView
      : null
  const taskMode = params.get('taskMode')
  const listMode =
    taskMode === 'projects' || (taskMode === null && projectMode) ? 'projects' : 'tasks'
  const planViewParam = params.get('planView')
  const planView: CollaborationView = [
    'board',
    'calendar',
    'gantt',
    'table',
    'milestones',
    'files',
  ].includes(planViewParam ?? '')
    ? (planViewParam as CollaborationView)
    : 'board'
  const identity = JSON.stringify([
    workbenchOwnershipKey(cloud, state.user),
    projectStore,
    projectId,
    issueId,
  ])
  const commentId = params.get('commentId')
  const commentNodes = commentId
    ? stream.timeline.nodes.filter(
        node => node.id === commentId || node.clientMessageId === commentId
      )
    : []
  const selectedNodeId =
    params.get('nodeId') ?? (commentNodes.length === 1 ? commentNodes[0].id : null)
  const timelineFilter: TimelineFilter = selectedNodeId
    ? 'all'
    : params.get('timelineFilter') === 'attachments'
      ? 'attachments'
      : params.get('timelineFilter') === 'conclusions'
        ? 'conclusions'
        : 'all'
  const discussion =
    (params.get('nodeId')
      ? stream.timeline.nodes.find(node => node.id === params.get('nodeId'))?.conversation.items
      : stream.conversations.items
    )?.find(conversation => conversation.key === params.get('discussion')) ?? null
  const discussionIdentity = `${identity}:${discussion?.key ?? ''}`
  const [conclusionView, setConclusionView] = useState<string | null>(null)
  const onConclusionViewChange = useCallback(
    (open: boolean) => setConclusionView(open ? discussionIdentity : null),
    [discussionIdentity]
  )
  const [attachment, setAttachment] = useState<{
    identity: string
    value: TimelineAttachmentSelection
  } | null>(null)
  const navigate = useCallback(
    (updates: Record<string, string | null | undefined>) =>
      navigateTo(buildCollaborationExpRoute(params, updates)),
    [params]
  )
  const selectIssue = (project: ExperienceProjectScope, id: string) => {
    setAttachment(null)
    navigate({
      ...closedIssueRoute,
      view: 'tasks',
      projectId: project.id,
      projectStore: project.store,
      issueId: id,
    })
  }
  const changeFilters = (next: TaskFilterValue) => {
    const scope = projects.find(project => project.key === next.projectKey)
    navigate({
      ...closedIssueRoute,
      relevance: next.relevance,
      search: next.search || null,
      status: next.status || null,
      projectScope: scope?.key ?? null,
      projectId: scope?.id ?? null,
      projectStore: scope?.store ?? null,
      projectView: null,
      taskMode: listMode === 'projects' ? 'projects' : null,
    })
  }
  const refresh = () => {
    tasks.reload()
    setDetailRevision(value => value + 1)
  }
  const closeDiscussion = () => navigate({ discussion: null, nodeId: null })
  const closeIssue = () => navigate(closedIssueRoute)
  const closeProject = () =>
    navigate({
      ...closedIssueRoute,
      taskMode: listMode === 'projects' ? 'projects' : null,
      projectView: null,
    })
  const openProject = (project: ExperienceProjectScope) =>
    navigate({
      ...closedIssueRoute,
      view: 'tasks',
      taskMode: listMode,
      projectId: project.id,
      projectStore: project.store,
      projectView: 'overview',
    })
  const panes: ExperiencePane[] = [
    {
      id: 'tasks',
      title: t('tasks.title'),
      header: null,
      scroll: false,
      scrollSelector: '.experience-task-scroll',
      minWidth: 240,
      defaultWidth: 300,
      content: (
        <TaskListView
          scrollOwner={JSON.stringify([cloud.apiBaseUrl, viewer])}
          rows={rows}
          onCreate={() => setCreateIssueOpen(true)}
          projectData={projectData}
          onCreateProject={() => setCreateProjectOpen(true)}
          mode={listMode}
          onModeChange={next => {
            if (next !== listMode) {
              navigate({ taskMode: next === 'projects' || projectMode ? next : null })
            }
          }}
          projects={projects}
          statuses={statuses}
          filters={filters}
          selectedKey={
            detail.data
              ? JSON.stringify([
                  detail.data.project.project_store,
                  detail.data.project.id,
                  detail.data.issue.id,
                ])
              : null
          }
          loading={tasks.loading}
          loadMoreReady={tasks.loadMoreReady}
          error={
            tasks.errors.length || tasks.relatedError || tasks.subscriptionError
              ? t('tasks.loadFailed')
              : null
          }
          hasMore={tasks.hasMore}
          onFiltersChange={changeFilters}
          onSelect={(row: ExperienceTaskRow) => selectIssue(row.project, row.id)}
          onOpenProject={openProject}
          onRetry={refresh}
          onLoadMore={() => void tasks.loadMore()}
        />
      ),
    },
  ]
  if (!issueId && !projectMode)
    panes.push({
      id: 'task-home',
      title: t('tasks.home.console'),
      header: null,
      desktopOnly: true,
      minWidth: 360,
      defaultWidth: 360,
      content:
        listMode === 'projects' ? (
          <ProjectHome
            projects={projects}
            rows={rows}
            projectData={projectData}
            onOpenProject={openProject}
            onCreate={() => setCreateProjectOpen(true)}
          />
        ) : (
          <TaskHome
            rows={rows}
            onCreate={() => setCreateIssueOpen(true)}
            team={
              state.user ? (
                <AssistantTeamRelay compact active={active} projects={projectData} />
              ) : null
            }
            onSelect={row => selectIssue(row.project, row.id)}
          />
        ),
    })
  if (selectedProject && source && projectMode)
    panes.push({
      id: 'project',
      title: selectedProject.name,
      scroll: false,
      minWidth: 320,
      defaultWidth: 680,
      onBack: closeProject,
      content: (
        <ProjectExperience
          project={selectedProject}
          api={source.api}
          view={projectMode}
          planView={planView}
          active={active}
          onViewChange={next => navigate({ projectView: next })}
          onPlanViewChange={next => navigate({ projectView: 'plan', planView: next })}
          onOpenIssue={id => selectIssue(projectScopeOf(selectedProject), id)}
          onBack={closeProject}
        />
      ),
    })
  if (projectMode && projectId && !selectedProject && !issueId)
    panes.push({
      id: 'project',
      title: t('tasks.project'),
      minWidth: 320,
      defaultWidth: 680,
      onBack: closeProject,
      content: (
        <p
          className="p-5"
          role={tasks.loading ? 'status' : 'alert'}
          data-testid="collaboration-exp-project-status"
        >
          {t(tasks.loading ? 'loading' : 'tasks.projectUnavailable')}
        </p>
      ),
    })
  if (issueId)
    panes.push({
      id: 'timeline',
      title: detail.data?.issue.title ?? t('timeline.title'),
      scroll: false,
      minWidth: 360,
      defaultWidth: 620,
      actions: detail.data ? (
        <>
          <Circle
            size={16}
            aria-label={detail.data.issue.status}
            role="img"
            className="experience-header-status"
          />
          <ControlButton
            variant="unstyled"
            type="button"
            className="experience-header-tool"
            title={t('timeline.attachments')}
            aria-label={t('timeline.attachments')}
            data-testid="collaboration-exp-header-attachments"
            onClick={() =>
              navigate({
                timelineFilter: timelineFilter === 'attachments' ? null : 'attachments',
                nodeId: null,
                commentId: null,
                focusRequest: null,
              })
            }
          >
            <Paperclip size={16} aria-hidden="true" />
          </ControlButton>
          <ControlButton
            variant="unstyled"
            type="button"
            className="experience-header-tool"
            title={t('timeline.openProject', { name: detail.data.project.name })}
            aria-label={t('timeline.openProject', { name: detail.data.project.name })}
            data-testid="collaboration-exp-header-project"
            onClick={() => openProject(projectScopeOf(detail.data!.project))}
          >
            <FolderKanban size={16} aria-hidden="true" />
          </ControlButton>
          <ControlButton
            variant="unstyled"
            type="button"
            className="experience-header-tool"
            title={t('timeline.details')}
            aria-label={t('timeline.details')}
            data-testid="collaboration-exp-header-details"
            onClick={() => navigate({ inspector: 'summary', discussion: null, nodeId: null })}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </ControlButton>
        </>
      ) : undefined,
      onBack: closeIssue,
      content:
        detail.data && source ? (
          <TaskTimeline
            key={identity}
            api={source.api}
            data={detail.data}
            stream={stream}
            active={active}
            revision={detailRevision}
            selectedNodeId={selectedNodeId}
            focusRequest={params.get('focusRequest')}
            anchorUnavailable={Boolean(
              commentId && !selectedNodeId && stream.timeline.state === 'ready'
            )}
            filter={timelineFilter}
            onFilterChange={filter =>
              navigate({
                timelineFilter: filter === 'all' ? null : filter,
                nodeId: null,
                commentId: null,
                focusRequest: null,
              })
            }
            onDiscuss={(node, conversation) => {
              setAttachment(null)
              navigate({
                discussion: conversation.key,
                inspector: null,
                nodeId: node?.id ?? null,
                commentId: null,
                focusRequest: null,
              })
            }}
            onAttachment={value => {
              setAttachment({ identity, value })
              navigate({
                discussion: null,
                nodeId: value.sourceNodeId,
                commentId: null,
                focusRequest: null,
              })
            }}
            onExecution={address =>
              navigateTo(
                buildRuntimeTaskRoute({
                  ...address,
                  ...(detail.data?.project.project_store === 'backend' && projectId && issueId
                    ? {
                        issueExecution: { projectId, issueId },
                        projectSession: { projectId, issueId },
                      }
                    : {}),
                })
              )
            }
            onRetry={refresh}
          />
        ) : (
          <div className="p-5" role={detail.error ? 'alert' : 'status'}>
            {detail.loading ? t('loading') : t('unavailable')}
            {detail.error ? (
              <Button
                variant="ghost"
                data-testid="collaboration-exp-detail-retry"
                onClick={refresh}
              >
                {t('retry')}
              </Button>
            ) : null}
          </div>
        ),
    })
  const discussionData = detail.data
  if (discussionData && source && params.get('discussion'))
    panes.push({
      id: 'discussion',
      title: t(
        params.get('nodeId')
          ? 'private.sourceTitle'
          : conclusionView === discussionIdentity
            ? 'private.previewTitle'
            : 'private.title'
      ),
      actions: <Lock size={15} aria-hidden="true" />,
      scroll: false,
      minWidth: 320,
      defaultWidth: 480,
      onBack: closeDiscussion,
      content: onBack =>
        discussion ? (
          <PrivateDiscussionPane
            key={`${identity}:${discussion.key}`}
            api={source.api}
            project={discussionData.project}
            issue={discussionData.issue}
            conversation={discussion}
            participationViewer={discussionData.participationViewer}
            sourceNodeId={params.get('nodeId') ?? undefined}
            historyScope={params.get('nodeId') ? 'source' : 'task'}
            active={active}
            embedded
            onClose={onBack}
            onContinue={() => navigate({ nodeId: null })}
            onConclusionViewChange={onConclusionViewChange}
            onPublished={refresh}
          />
        ) : (
          <p className="p-5 text-sm text-text-secondary">{t('timeline.discussionUnknown')}</p>
        ),
    })
  if (detail.data && source && params.get('inspector') === 'details')
    panes.push({
      id: 'issue-details',
      title: t('timeline.details'),
      scroll: false,
      minWidth: 360,
      defaultWidth: 480,
      onBack: () => navigate({ inspector: null }),
      content: (
        <ExperienceIssueDetails
          api={source.api}
          data={detail.data}
          active={active}
          revision={detailRevision}
          onClose={() => navigate({ inspector: null })}
          onChange={refresh}
        />
      ),
    })
  const currentAttachment = attachment?.identity === identity ? attachment.value : null
  const readAttachment = useCallback(
    (id: string) => {
      if (!source || !projectId || !issueId)
        return Promise.reject(new Error('Attachment context is unavailable'))
      return source.api.attachments.read(id, { projectId, issueId })
    },
    [source, projectId, issueId]
  )
  const openResourceAttachment = useCallback(
    (file: CollaborationAttachment) => {
      setAttachment({
        identity,
        value: { id: file.id, name: file.display_name, sourceNodeId: null },
      })
      navigate({ discussion: null, inspector: null })
    },
    [identity, navigate]
  )
  return (
    <IssueMarkdownProvider
      attachments={source?.api.attachments}
      issueId={issueId ?? undefined}
      projectId={projectId ?? undefined}
      onOpenAttachment={openResourceAttachment}
    >
      <main
        className="collaboration-exp-app h-full min-h-0 min-w-0 overflow-hidden bg-background text-text-primary"
        data-testid="collaboration-exp-app"
      >
        <ExperiencePanes panes={panes} />
        {active && detail.data && params.get('inspector') === 'summary' ? (
          <ExperienceIssueSummary
            key={identity}
            data={detail.data}
            onClose={() => navigate({ inspector: null })}
            onConfigure={() => navigate({ inspector: 'details' })}
            onProject={openProject}
          />
        ) : null}
        {createIssueOpen ? (
          <CreateExperienceIssue
            active={active}
            sources={sources}
            projects={projectData}
            onClose={() => setCreateIssueOpen(false)}
            onCreated={(project, issue) => {
              setCreateIssueOpen(false)
              refresh()
              selectIssue(project, issue.id)
            }}
          />
        ) : null}
        {createProjectOpen ? (
          <ProjectCreateDialog
            targets={projectCreateTargets}
            defaultLocation={services.projectSpaceApis?.defaultLocation ?? 'cloud'}
            allowDingTalkAITable
            labels={projectCreateLabels[locale]}
            host={{ parseDingTalkAITableLink }}
            onClose={() => setCreateProjectOpen(false)}
            onCreated={(project, location) => {
              setCreateProjectOpen(false)
              refresh()
              openProject(
                projectScopeOf({
                  ...project,
                  project_store: location === 'local' ? 'local' : 'backend',
                })
              )
            }}
          />
        ) : null}
        {currentAttachment ? (
          <BrowserAttachmentPreview
            attachmentId={currentAttachment.id}
            filename={currentAttachment.name}
            translate={translate}
            read={readAttachment}
            onClose={() => setAttachment(null)}
            onOpenAttachment={(id, name) =>
              setAttachment({
                identity,
                value: { id, name, sourceNodeId: currentAttachment.sourceNodeId },
              })
            }
          />
        ) : null}
      </main>
    </IssueMarkdownProvider>
  )
}
