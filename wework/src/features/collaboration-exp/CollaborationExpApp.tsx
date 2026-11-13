import { useCallback, useMemo, useState } from 'react'
import { BrowserAttachmentPreview, createCollaborationTranslator } from '@wegent/collaboration'
import type { CollaborationView } from '@wegent/collaboration'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { Button } from '@/components/ui/button'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useCollaborationMarkdownServices } from '@/features/todo/useCollaborationMarkdownServices'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { useExperienceSources } from './data/useExperienceSources'
import { useExperienceTasks } from './data/useExperienceTasks'
import { useExperienceIssue } from './data/useExperienceIssue'
import { useExperienceTimeline } from './data/useExperienceTimeline'
import { buildCollaborationExpRoute } from './integration/deepLinks'
import { projectScopeOf, selectProjectScopes, selectTaskRows } from './model'
import type {
  ExperiencePrivateConversation,
  ExperienceProjectScope,
  ExperienceTaskRow,
} from './model/types'
import { AssistantConversationPane, AssistantHome, AssistantTeamRelay } from './assistant'
import { ExperienceNavigation, ExperiencePanes, type ExperiencePane } from './shell'
import { TaskListView } from './tasks/TaskListView'
import type { TaskFilterValue } from './tasks/TaskFilters'
import { ProjectExperience } from './tasks/ProjectExperience'
import type { ProjectDrilldownView } from './tasks/ProjectDrilldown'
import { TaskTimeline, type TimelineAttachmentSelection } from './timeline/TaskTimeline'
import { PrivateDiscussionPane } from './private'

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
      <ExperienceContent active={active} search={search} />
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
  const view =
    params.get('view') === 'tasks' || (params.get('view') !== 'assistant' && params.has('issueId'))
      ? 'tasks'
      : 'assistant'
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
  const detail = useExperienceIssue(
    source,
    projectId,
    issueId,
    active && view === 'tasks',
    tasks.revision + detailRevision
  )
  const stream = useExperienceTimeline(
    source?.api,
    detail.data,
    viewer,
    state.runtimeWork,
    active && view === 'tasks',
    detailRevision
  )
  const readInput = { projects: tasks.projects, viewer, runtimeWork: state.runtimeWork }
  const assistantProjects = detail.data
    ? [
        ...tasks.projects,
        {
          project: detail.data.project,
          issues: [detail.data.issue],
          taskBindings: detail.data.taskBindings,
        },
      ]
    : tasks.projects
  const assistantConversations = selectTaskRows(
    { ...readInput, projects: assistantProjects },
    { relevance: 'all' }
  ).flatMap(row => row.conversations.items)
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
  const discussion =
    (params.get('nodeId')
      ? stream.timeline.nodes.find(node => node.id === params.get('nodeId'))?.conversation.items
      : stream.conversations.items
    )?.find(conversation => conversation.key === params.get('discussion')) ?? null
  const [attachment, setAttachment] = useState<{
    identity: string
    value: TimelineAttachmentSelection
  } | null>(null)
  const navigate = (updates: Record<string, string | null | undefined>) =>
    navigateTo(buildCollaborationExpRoute(params, updates))
  const selectIssue = (project: ExperienceProjectScope, id: string) => {
    setAttachment(null)
    navigate({
      view: 'tasks',
      projectId: project.id,
      projectStore: project.store,
      issueId: id,
      nodeId: null,
      discussion: null,
      commentId: null,
      focusRequest: null,
      assistantDeviceId: null,
      assistantTaskId: null,
    })
  }
  const openConversation = (conversation: ExperiencePrivateConversation) => {
    setAttachment(null)
    if (conversation.issueSource) {
      navigate({
        view: 'tasks',
        ...conversation.issueSource,
        discussion: conversation.key,
        nodeId: null,
        commentId: null,
        focusRequest: null,
        assistantDeviceId: null,
        assistantTaskId: null,
      })
      return
    }
    navigate({
      view: 'assistant',
      assistantDeviceId: conversation.address.deviceId,
      assistantTaskId: conversation.address.taskId,
    })
  }
  const changeFilters = (next: TaskFilterValue) => {
    const scope = projects.find(project => project.key === next.projectKey)
    navigate({
      relevance: next.relevance,
      search: next.search || null,
      status: next.status || null,
      projectScope: scope?.key ?? null,
      projectId: scope?.id ?? null,
      projectStore: scope?.store ?? null,
      projectView: null,
      issueId: null,
      nodeId: null,
      discussion: null,
      commentId: null,
      focusRequest: null,
    })
  }
  const refresh = () => {
    tasks.reload()
    setDetailRevision(value => value + 1)
  }
  const closeDiscussion = () => navigate({ discussion: null, nodeId: null })
  const openProject = (project: ExperienceProjectScope) =>
    navigate({
      view: 'tasks',
      projectId: project.id,
      projectStore: project.store,
      projectScope: project.key,
      projectView: 'overview',
      issueId: null,
      discussion: null,
      nodeId: null,
      commentId: null,
      focusRequest: null,
    })
  const navigation = (
    <ExperienceNavigation
      activeView={view}
      onViewChange={next => navigate({ view: next })}
      projectNavigation={projects.map(project => (
        <Button
          key={project.key}
          variant="ghost"
          className="min-h-11 w-full justify-start truncate md:min-h-8"
          data-testid={`collaboration-exp-project-nav-${project.store}-${project.id}`}
          onClick={() => openProject(project)}
        >
          {project.name}
        </Button>
      ))}
    />
  )
  const panes: ExperiencePane[] = [
    {
      id: view,
      title: t(view === 'assistant' ? 'shell.assistant' : 'tasks.title'),
      scroll: false,
      minWidth: 280,
      defaultWidth: view === 'tasks' ? 360 : 900,
      content:
        view === 'tasks' ? (
          <TaskListView
            rows={rows}
            team={
              state.user ? (
                <AssistantTeamRelay active={active} projects={assistantProjects} />
              ) : null
            }
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
        ) : state.user ? (
          <AssistantHome
            active={active}
            projects={assistantProjects}
            conversations={assistantConversations}
            onOpenIssue={selectIssue}
            onOpenConversation={openConversation}
          />
        ) : (
          <p className="p-5">{t('unavailable')}</p>
        ),
    },
  ]
  const assistantDeviceId = params.get('assistantDeviceId')
  const assistantTaskId = params.get('assistantTaskId')
  if (view === 'assistant' && assistantDeviceId && assistantTaskId)
    panes.push({
      id: 'assistant-conversation',
      title: t('private.title'),
      scroll: false,
      minWidth: 320,
      defaultWidth: 560,
      onBack: () => navigate({ assistantDeviceId: null, assistantTaskId: null }),
      content: (
        <AssistantConversationPane
          active={active}
          address={{ deviceId: assistantDeviceId, taskId: assistantTaskId }}
        />
      ),
    })
  if (view === 'tasks' && selectedProject && source && projectMode)
    panes.push({
      id: 'project',
      title: selectedProject.name,
      scroll: false,
      minWidth: 320,
      defaultWidth: 680,
      onBack: () => navigate({ projectView: null, issueId: null, nodeId: null, discussion: null }),
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
          onBack={() => navigate({ projectView: null })}
        />
      ),
    })
  if (view === 'tasks' && issueId)
    panes.push({
      id: 'timeline',
      title: detail.data?.issue.title ?? t('timeline.title'),
      scroll: false,
      minWidth: 320,
      defaultWidth: 620,
      onBack: () => navigate({ issueId: null, discussion: null, nodeId: null }),
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
            onDiscuss={(node, conversation) => {
              setAttachment(null)
              navigate({
                discussion: conversation.key,
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
  if (view === 'tasks' && detail.data && source && params.get('discussion'))
    panes.push({
      id: 'discussion',
      title: t('private.title'),
      scroll: false,
      minWidth: 320,
      defaultWidth: 480,
      onBack: closeDiscussion,
      content: discussion ? (
        <PrivateDiscussionPane
          key={`${identity}:${discussion.key}`}
          api={source.api}
          project={detail.data.project}
          issue={detail.data.issue}
          conversation={discussion}
          sourceNodeId={params.get('nodeId') ?? undefined}
          historyScope={params.get('nodeId') ? 'source' : 'task'}
          active={active}
          embedded
          onPublished={refresh}
        />
      ) : (
        <p className="p-5 text-sm text-text-secondary">{t('timeline.discussionUnknown')}</p>
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
  return (
    <main
      className="h-full min-h-0 min-w-0 overflow-hidden bg-background text-text-primary"
      data-testid="collaboration-exp-app"
    >
      <ExperiencePanes
        panes={panes}
        navigation={navigation}
        navigationTitle={t('title')}
        mobileNavigation={
          <ExperienceNavigation activeView={view} onViewChange={next => navigate({ view: next })} />
        }
      />
      {currentAttachment ? (
        <BrowserAttachmentPreview
          attachmentId={currentAttachment.id}
          filename={currentAttachment.name}
          translate={translate}
          read={readAttachment}
          onClose={() => setAttachment(null)}
        />
      ) : null}
    </main>
  )
}
