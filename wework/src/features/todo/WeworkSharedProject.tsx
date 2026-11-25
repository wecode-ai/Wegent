import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { createWeworkProjectSession } from './weworkProjectSession'

import { DesktopProjectSettingsPages } from './DesktopProjectSettingsPages'

import { prepareIssueRuntimeTask } from './prepareIssueRuntimeTask'

import { IssueChangeRequestBadges } from '@/features/change-requests/IssueChangeRequestBadges'

import { bindProjectStandInApi } from '@/api/standIn'

import { PersonalHomeIssuePanel } from './PersonalHomeIssuePanel'

import { ProjectCoordinatorConversation } from './ProjectCoordinatorConversation'
import { ProjectSpaceChatSidebar } from './ProjectSpaceChatSidebar'
import { ArrowUpRight, Maximize2, Minimize2, MessageSquare } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { StandInPopover } from './StandInPopover'

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  CollaborationApp,
  collaborationTestIds,
  createCollaborationTranslator,
  IssueConversationDrawers,
  type CollaborationHostAdapter,
  type CollaborationIssueDetailRenderContext,
  type CollaborationIssue,
  type SharedWorkspaceApi,
  type WorkspaceTaskBinding,
} from '@wegent/collaboration'

import { type CloudLoopItem, type CloudProject } from '@/api/deliveries'
import { loopItemLocalProject } from '@/api/localProjectAssociation'
import { useTranslation } from '@/hooks/useTranslation'

import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { getChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'

import { TransientNotice } from '@/components/common/TransientNotice'
import { resolveDeviceResourceSettingsOptions } from './deviceResourceSettings'

import { normalizeClipboardImageFiles } from '@/lib/clipboard-images'

import { createWeworkProjectAgentConfigurationHost } from '@/features/collaboration/WeworkProjectAgentConfigurationHost'

import { issueDispatchPersonalTaskInput } from '@/features/notifications/NotificationTaskSourceContext'
import { humanTaskDispatchInput } from './humanTaskDispatch'

import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useCloudIssueApis } from './useCloudIssueApis'
import { SharedIssueSourceButton } from './SharedIssueSourceButton'

import { getRuntimeWorkDeviceNamesById, getWorkbenchDeviceNamesById } from '@/lib/workbench-device'
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import { isRuntimeTaskExecutionRunning } from '@/features/workbench/runtimeTaskLifecycle/projection'
import { AiChatModal } from './AiChatModal'
import { CloudTodoBoardCard, type CloudTodoBoardTaskBinding } from './CloudTodoBoardCard'
import { runtimeTaskConversationStatusesByAddress } from './runtimeTaskConversationStatus'
import { TodoEditor } from './TodoEditor'

import { workItemComposerReference } from './workItemTaskInput'
import {
  loadProjectSpaceCodeWorkspacePreference,
  saveProjectSpaceCodeWorkspacePreference,
} from './projectSpaceCodeWorkspacePreference'

import {
  issueTaskExecutionStates,
  toWeworkIssueTaskBinding,
  issueExecutionAddress,
  workspaceExecutionAddress,
} from './weworkCollaborationRuntime'
import type { WeworkSharedProjectProps } from './weworkCollaborationTypes'
export function WeworkSharedProject({
  api,
  projectCatalogApi,
  detailServices,
  devices,
  focusedCommentId,
  focusedCommentRequestKey,
  focusedItemId,
  localProjects,
  locale,
  location,
  onFocusedItemHandled,
  onOpenSettings,
  onOpenStandInSettings,
  standInDeviceId,
  onOpenRuntimeTask,
  onCancelRuntimeTask,
  project,
  conversationRequestKey,
  onOpenProjectConversation,
  runtimeTaskLifecycle,
  runtimeWork,
  runtimePort,
  services,
  setLocation,
  userId,
  workspace,
  personalIssue,
}: WeworkSharedProjectProps) {
  const { t } = useTranslation('common')
  const preferences = useAppPreferencesState()
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const [closedConversationRequestKey, setClosedConversationRequestKey] = useState<string>()
  const projectChatOpen = Boolean(
    conversationRequestKey && conversationRequestKey !== closedConversationRequestKey
  )
  const issueChangeRequestMonitor =
    services.deviceApi && (preferences?.preferences.changeRequestStatusEnabled ?? true)
      ? getChangeRequestMonitor(services.deviceApi)
      : null
  const [localDetailExpanded, setLocalDetailExpanded] = useState(false)
  const detailExpanded = personalIssue?.detailExpanded ?? localDetailExpanded
  const setDetailExpanded = personalIssue?.onDetailExpandedChange ?? setLocalDetailExpanded
  const cloudConnection = useOptionalCloudConnection()
  const personalIssuesApi = useCloudIssueApis(cloudConnection)?.personal
  const sessionOwner = [
    project.id,
    project.project_store,
    userId,
    cloudConnection.apiBaseUrl,
    cloudConnection.user?.id,
  ]
  const [ownedSession, setOwnedSession] = useState(() => ({
    owner: sessionOwner,
    source: createWeworkProjectSession({ project, userId }),
  }))
  let currentSession = ownedSession
  if (ownedSession.owner.some((value, index) => value !== sessionOwner[index])) {
    currentSession = {
      owner: sessionOwner,
      source: createWeworkProjectSession({ project, userId }),
    }
    setOwnedSession(currentSession)
  }
  const session = currentSession.source
  const closeTaskConversation = session.closeConversation
  const notify = session.notify
  const clearNotice = session.clearNotice
  const [pinnedProgressIssueId, setPinnedProgressIssueId] = useState<string | null>(null)
  if (location.issueId && pinnedProgressIssueId !== null) setPinnedProgressIssueId(null)
  const workspaceId = workspace?.id ?? null
  const hasFullWorkspaceAccess = workspace !== null && 'access_role' in workspace
  const scopedApi = useMemo<SharedWorkspaceApi>(
    () => ({
      ...api,
      projects: {
        ...api.projects,
        list: async () => {
          if (hasFullWorkspaceAccess && workspaceId) return api.projects.list(workspaceId)
          const accessibleProjects = await api.projects.list()
          return accessibleProjects.filter(candidate => String(candidate.id) === String(project.id))
        },
        create: input =>
          api.projects.create({
            ...input,
            ...(workspaceId ? { workspaceId } : {}),
          }),
      },
      issues: {
        ...api.issues,
        async getBoardSnapshot(projectId) {
          const snapshot = await api.issues.getBoardSnapshot(projectId)
          session.reconcileBindings(
            snapshot.taskBindings.map(binding => ({
              deviceId: binding.deviceId,
              taskId: binding.taskId,
            }))
          )
          return snapshot
        },
      },
    }),
    [api, project.id, workspaceId, hasFullWorkspaceAccess, session]
  )
  const standInWorkspaceApi = useMemo(
    () => ({
      ...scopedApi,
      projects: projectCatalogApi ?? api.projects,
      standIn:
        services.standInApi && services.getLocalRuntimeSidebarIdentity
          ? bindProjectStandInApi(
              services.standInApi,
              Number(userId),
              project.project_store === 'local' ? 'local' : 'cloud',
              services.getLocalRuntimeSidebarIdentity
            )
          : scopedApi.standIn,
    }),
    [
      scopedApi,
      api.projects,
      projectCatalogApi,
      services.standInApi,
      services.getLocalRuntimeSidebarIdentity,
      userId,
      project.project_store,
    ]
  )
  const projectAgentConfiguration = useMemo(
    () =>
      createWeworkProjectAgentConfigurationHost(
        services.agentResourceApi,
        services.localProjectChatAgentApi,
        project.project_store === 'local' ? detailServices?.modelApi : undefined,
        services.pluginApi,
        services.deviceApi,
        project.project_store !== 'local' && detailServices
          ? { agents: api.agents, modelApi: detailServices.modelApi, name: project.name }
          : undefined
      ),
    [
      services.agentResourceApi,
      services.localProjectChatAgentApi,
      project.project_store,
      services.pluginApi,
      services.deviceApi,
      api.agents,
      detailServices,
      project.name,
    ]
  )
  const projectHost = useMemo<CollaborationHostAdapter>(
    () => ({
      settingsPages: DesktopProjectSettingsPages,
      renderBoardToolbarAction: onOpenProjectConversation
        ? () => (
            <Tooltip label={t('workbench.project_space_chat.open')} side="bottom">
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="project-space-chat-open"
                aria-label={t('workbench.project_space_chat.open')}
                aria-expanded={projectChatOpen}
                onClick={() => {
                  if (projectChatOpen) setClosedConversationRequestKey(conversationRequestKey)
                  else onOpenProjectConversation()
                }}
                className="project-board-compact-action inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-background px-3 text-sm text-text-secondary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
              >
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
                <span className="project-board-action-label">
                  {t('workbench.project_space_chat.open')}
                </span>
              </ControlButton>
            </Tooltip>
          )
        : undefined,
      renderProjectHeaderAction: currentProject => (
        <div className="flex items-center gap-2">
          {experimentalFeaturesEnabled && (
            <ProjectCoordinatorConversation
              key={`${currentProject.project_store}:${currentProject.id}:${userId}`}
              api={scopedApi}
              project={currentProject}
              services={services}
              userId={Number(userId)}
              devices={devices ?? []}
              onOpenTask={onOpenRuntimeTask}
              onPublished={() => session.requestRefresh()}
              onOpenIssue={issueId => {
                session.closeConversation()
                setLocation(current => ({ ...current, projectView: 'board', issueId }))
                if (focusedItemId) onFocusedItemHandled?.()
              }}
              onOpenGroupSettings={() => {
                session.closeConversation()
                setLocation(current => ({
                  ...current,
                  projectView: 'manage',
                  projectSettingsSection: 'groups',
                  issueId: null,
                }))
                if (focusedItemId) onFocusedItemHandled?.()
              }}
            />
          )}
          <StandInPopover
            key={currentProject.id}
            api={standInWorkspaceApi}
            project={currentProject}
            devices={devices}
            readLocalIdentity={services.getLocalRuntimeSidebarIdentity}
            services={services}
            userId={Number(userId)}
            onOpenPersonalSettings={onOpenStandInSettings}
            initialDeviceId={standInDeviceId}
          />
        </div>
      ),
      capabilities: {
        automation: true,
        dingtalkAitable: true,
        projectLocation: project.project_store === 'local' ? 'local' : 'cloud',
      },
      location: {
        projectId: String(project.id),
        issueId: personalIssue?.issue.id ?? location.issueId,
        view: location.projectView,
        rootView: 'home',
        projectSettingsSection: location.projectSettingsSection,
      },
      navigate: next => {
        if (session.openPersonalIssue(next.issueId)) return
        session.retainConversationForIssue(next.issueId)
        setLocation(current => ({
          ...current,
          workspaceId,
          workspaceView: 'projects',
          projectId: next.projectId,
          projectView: next.view,
          projectSettingsSection:
            next.view === 'manage' ? (next.projectSettingsSection ?? null) : null,
          issueId: next.issueId,
        }))
        if (!next.issueId && focusedItemId) onFocusedItemHandled?.()
      },
      notify,
      ...(onOpenSettings
        ? {
            manageResource: (kind: 'agents' | 'environments', resourceId?: string) => {
              if (kind !== 'environments') return
              onOpenSettings(
                resolveDeviceResourceSettingsOptions(
                  resourceId,
                  project.project_store === 'local' ? 'local' : 'cloud'
                )
              )
            },
          }
        : {}),
      projectAgentConfiguration,
    }),
    [
      session,
      personalIssue,
      focusedItemId,
      devices,
      experimentalFeaturesEnabled,
      onOpenProjectConversation,
      projectChatOpen,
      conversationRequestKey,
      t,
      standInWorkspaceApi,
      scopedApi,
      onOpenRuntimeTask,
      onFocusedItemHandled,
      services,
      projectAgentConfiguration,
      userId,
      location.issueId,
      location.projectSettingsSection,
      location.projectView,
      onOpenSettings,
      onOpenStandInSettings,
      standInDeviceId,
      notify,
      project.id,
      project.project_store,
      setLocation,
      workspaceId,
    ]
  )
  const editorProject = useMemo(
    () =>
      ({
        ...project,
        location: project.project_store === 'local' ? 'local' : 'cloud',
      }) as unknown as CloudProject,
    [project]
  )
  const taskOwnerUserId = project.project_store === 'local' ? 0 : userId
  const deviceNamesById = useMemo(
    () => ({
      ...getWorkbenchDeviceNamesById(devices ?? []),
      ...getRuntimeWorkDeviceNamesById(runtimeWork),
    }),
    [devices, runtimeWork]
  )
  const runtimeExecutionStatusByAddress = useMemo(
    () => runtimeTaskConversationStatusesByAddress(runtimeWork, runtimeTaskLifecycle),
    [runtimeTaskLifecycle, runtimeWork]
  )
  const runtimeRunningByAddress = useMemo(() => {
    const running = new Map<string, boolean>()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(item => item.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const runtimeWorkspace of workspaces) {
      for (const task of runtimeWorkspace.tasks) {
        const key = runtimeConversationKey({
          deviceId: runtimeWorkspace.deviceId,
          taskId: task.taskId,
        })
        running.set(key, isRuntimeTaskExecutionRunning(task))
      }
    }
    for (const lifecycle of runtimeTaskLifecycle?.tasks.values() ?? []) {
      const key = runtimeConversationKey(lifecycle.address)
      running.set(key, lifecycle.execution.running || lifecycle.turn.active)
    }
    return running
  }, [runtimeTaskLifecycle, runtimeWork])
  const isIssueRunning = useCallback(
    (_issue: CollaborationIssue, bindings: WorkspaceTaskBinding[]) =>
      bindings.some(binding =>
        runtimeRunningByAddress.get(
          runtimeConversationKey({ deviceId: binding.deviceId, taskId: binding.taskId })
        )
      ),
    [runtimeRunningByAddress]
  )
  // Local archives require the Runtime to stop first. Cloud archives own the
  // tombstone and cancellation transaction in the Backend before stopping work.
  const prepareIssueArchive = useCallback(
    async (issue: CollaborationIssue) => {
      if (!onCancelRuntimeTask) return
      const bindings = await scopedApi.taskBindings.list(issue.id)
      const running = bindings.filter(
        binding =>
          runtimeRunningByAddress.get(
            runtimeConversationKey({ deviceId: binding.deviceId, taskId: binding.taskId })
          ) ?? false
      )
      await Promise.all(
        running.map(binding =>
          onCancelRuntimeTask({ deviceId: binding.deviceId, taskId: binding.taskId })
        )
      )
    },
    [onCancelRuntimeTask, runtimeRunningByAddress, scopedApi]
  )
  const sessionInput = useMemo(
    () => ({
      project,
      api,
      projectChatClient: detailServices?.projectChatClient,
      standInApi: services.standInApi,
      runtimeAvailable: Boolean(runtimePort),
      personalIssue,
      focusedItemId,
      runtimeWork,
      runtimeTaskLifecycle,
      detailExpanded,
      locationIssueId: projectHost.location.issueId,
      navigateIssue: (issueId: string) =>
        projectHost.navigate({ ...projectHost.location, issueId }),
      onOpenRuntimeTask,
      t,
    }),
    [
      project,
      api,
      detailServices?.projectChatClient,
      services.standInApi,
      runtimePort,
      personalIssue,
      focusedItemId,
      runtimeWork,
      runtimeTaskLifecycle,
      detailExpanded,
      projectHost,
      onOpenRuntimeTask,
      t,
    ]
  )
  const subscribeSession = useCallback(
    (listener: () => void) => session.subscribe(listener, sessionInput),
    [session, sessionInput]
  )
  const { taskComposer, notice, refreshProjectRequestKey, executionProject } = useSyncExternalStore(
    subscribeSession,
    session.getSnapshot,
    session.getSnapshot
  )
  const openNewTaskConversation = session.openNewConversation
  const openBoundTaskConversation = session.openBoundConversation
  const codeWorkspacePreference = loadProjectSpaceCodeWorkspacePreference(userId, {
    projectStore: project.project_store,
    projectId: String(project.id),
  })
  const issueLocalProjectId = taskComposer
    ? (loopItemLocalProject(taskComposer.issue as unknown as CloudLoopItem)?.id ?? null)
    : null
  const initialLocalProjectId =
    issueLocalProjectId ?? codeWorkspacePreference?.localProjectId ?? null
  const initialDeviceWorkspaceId =
    initialLocalProjectId === codeWorkspacePreference?.localProjectId
      ? (codeWorkspacePreference?.deviceWorkspaceId ?? null)
      : null
  const conversationPanel =
    taskComposer && runtimePort ? (
      <AiChatModal
        key={taskComposer.conversationKey}
        project={executionProject as unknown as CloudProject}
        localProjects={localProjects}
        task={taskComposer.issue as unknown as CloudLoopItem}
        initialLocalProjectId={initialLocalProjectId}
        initialDeviceWorkspaceId={initialDeviceWorkspaceId}
        initialTaskRequest={taskComposer.taskRequest}
        taskTitle={taskComposer.dispatch?.taskTitle}
        open
        embedded
        initialTaskInput={
          taskComposer.dispatch
            ? `${workItemComposerReference(project, taskComposer.issue)} ${issueDispatchPersonalTaskInput(taskComposer.dispatch)}`
            : workItemComposerReference(project, taskComposer.issue)
        }
        initialAddress={taskComposer.address}
        onClose={closeTaskConversation}
        onAddressChange={address => {
          session.updateConversationAddress(taskComposer.conversationKey, address)
        }}
        onOpenRuntimeTask={onOpenRuntimeTask}
        prepareTask={address =>
          prepareIssueRuntimeTask({
            port: runtimePort,
            project,
            address,
            issues: scopedApi.issues,
            onStatusError: error => notify(error || t('task_board_status_update_failed'), 'error'),
            issueId: taskComposer.issue.id,
            title: taskComposer.dispatch?.taskTitle ?? taskComposer.issue.title,
            dispatch: taskComposer.dispatch
              ? {
                  humanAssignmentId: taskComposer.dispatch.humanAssignmentId,
                  dispatchId: taskComposer.dispatch.dispatchId,
                  dispatchRoundId: taskComposer.dispatch.roundId,
                  assignmentId: taskComposer.dispatch.assignmentId,
                }
              : (taskComposer.humanTaskBinding ?? null),
          })
        }
        onTaskCreated={async (address, localProject, deviceWorkspaceId) => {
          if (localProject) {
            saveProjectSpaceCodeWorkspacePreference(
              userId,
              {
                projectStore: project.project_store,
                projectId: String(project.id),
              },
              {
                localProjectId: localProject.id,
                deviceWorkspaceId,
              }
            )
          }
          session.updateConversationAddress(taskComposer.conversationKey, address)
          session.requestRefresh()
        }}
      />
    ) : null

  const renderIssueEditor = (
    {
      commentBoard,
      api: issueApi,
      issue,
      allIssues,
      assignments,
      taskBindings,
      onRead,
      onChange,
      onCreateTask,
      onDelete,
      onOpenRelatedIssue,
      onAddChild,
    }: CollaborationIssueDetailRenderContext,
    closeDrawers: () => void
  ) => (
    <TodoEditor
      commentBoard={commentBoard}
      key={issue.id}
      getRuntimeTranscript={services.runtimeWorkApi?.getRuntimeTranscript}
      mode="edit"
      focusedCommentId={focusedItemId === issue.id ? focusedCommentId : null}
      focusedCommentRequestKey={focusedItemId === issue.id ? focusedCommentRequestKey : null}
      sharedApi={issueApi}
      api={services.deliveryApi}
      presentation="workspace-panel"
      workspacePanelFill
      readFirst
      showPanelControls
      showFullscreenControl={!personalIssue}
      headerActions={
        <>
          {project.project_store === 'backend' &&
            personalIssuesApi &&
            Number(cloudConnection.user?.id) === issue.created_by_user_id && (
              <SharedIssueSourceButton
                key={issue.id}
                api={personalIssuesApi}
                issueId={issue.id}
                onOpen={closeDrawers}
              />
            )}
          {personalIssue?.presentation === 'drawer' ? (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="personal-issue-detail-expand"
              aria-label={t(
                detailExpanded
                  ? 'workbench.restore_right_workspace_panel'
                  : 'workbench.expand_right_workspace_panel'
              )}
              title={t(
                detailExpanded
                  ? 'workbench.restore_right_workspace_panel'
                  : 'workbench.expand_right_workspace_panel'
              )}
              aria-pressed={detailExpanded}
              onClick={() => setDetailExpanded(!detailExpanded)}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md md:h-8 md:w-8 text-text-secondary hover:bg-muted hover:text-text-primary"
            >
              {detailExpanded ? (
                <Minimize2 aria-hidden="true" className="h-4 w-4" />
              ) : (
                <Maximize2 aria-hidden="true" className="h-4 w-4" />
              )}
            </ControlButton>
          ) : null}
          {personalIssue?.onOpenInProject ? (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="personal-home-open-in-project"
              aria-label={t('personalHome.openInProject')}
              title={t('personalHome.openInProject')}
              onClick={personalIssue.onOpenInProject}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md md:h-8 md:w-8 text-text-secondary hover:bg-muted hover:text-text-primary"
            >
              <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
            </ControlButton>
          ) : null}
        </>
      }
      item={issue as unknown as CloudLoopItem}
      project={editorProject}
      allItems={allIssues as unknown as CloudLoopItem[]}
      showChildren={false}
      onOpenRelatedIssue={related => onOpenRelatedIssue(related as unknown as CollaborationIssue)}
      onAddChild={onAddChild}
      projectChatAgentApi={detailServices?.projectChatAgentApi}
      projectChatClient={detailServices?.projectChatClient}
      selfManagedExecution={project.project_store === 'local'}
      currentUserId={editorProject.current_user_id ?? userId}
      currentAssignment={
        assignments
          .filter(assignment => assignment.status === 'active')
          .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
          .at(-1) ?? null
      }
      localProjects={localProjects}
      initialTaskBindings={taskBindings.map(toWeworkIssueTaskBinding)}
      taskExecutionStates={issueTaskExecutionStates(taskBindings, runtimeExecutionStatusByAddress)}
      deviceNamesById={deviceNamesById}
      selectedTaskId={
        taskComposer?.issue.id === issue.id ? (taskComposer.address?.taskId ?? null) : null
      }
      aitableApi={project.task_provider === 'dingtalk_aitable' ? services.aitableApi : undefined}
      existingTaskSource={runtimePort ? { work: runtimeWork, port: runtimePort } : undefined}
      onCreateTask={onCreateTask}
      onDelete={onDelete}
      deleteLabel={createCollaborationTranslator(locale)('todo.archive_issue')}
      onOpenRuntimeTask={
        runtimePort
          ? address => session.openIssueExecutionConversation(issue, address)
          : onOpenRuntimeTask
      }
      onStartHumanTaskFromReply={({ issueId, dispatch }) =>
        String(issueId) === String(issue.id)
          ? openNewTaskConversation(issue, humanTaskDispatchInput(dispatch))
          : undefined
      }
      onOpenTaskConversation={
        runtimePort
          ? task =>
              void openBoundTaskConversation(
                issue,
                issueExecutionAddress(
                  task,
                  runtimeWork,
                  String(project.id),
                  issue.id,
                  project.project_store
                )
              )
          : onOpenRuntimeTask
            ? task =>
                onOpenRuntimeTask(
                  issueExecutionAddress(
                    task,
                    runtimeWork,
                    String(project.id),
                    issue.id,
                    project.project_store
                  )
                )
            : undefined
      }
      onEscape={taskComposer?.issue.id === issue.id ? closeTaskConversation : closeDrawers}
      onUpdated={updated => onChange(updated as unknown as CollaborationIssue)}
      onRead={updated => onRead(updated as unknown as CollaborationIssue)}
      onClose={closeDrawers}
    />
  )

  const renderIssueDetail = (context: CollaborationIssueDetailRenderContext) => (
    <IssueConversationDrawers
      embedded={Boolean(personalIssue)}
      key={context.issue.id}
      label={createCollaborationTranslator(locale)('todo.issue_details')}
      conversation={taskComposer?.issue.id === context.issue.id ? conversationPanel : null}
      conversationKey={taskComposer?.conversationKey}
      onClose={() => {
        closeTaskConversation()
        context.onClose()
      }}
      onCloseConversation={closeTaskConversation}
    >
      {closeDrawers => renderIssueEditor(context, closeDrawers)}
    </IssueConversationDrawers>
  )

  return (
    <div
      className="issue-drawer-workspace relative flex h-full min-h-0 min-w-0"
      data-testid="issue-drawer-workspace"
    >
      <TransientNotice
        message={notice?.message ?? null}
        tone={notice?.tone}
        onClear={clearNotice}
      />
      <div className="min-w-0 flex-1">
        {personalIssue ? (
          <IssueConversationDrawers
            embedded
            key={personalIssue.issue.id}
            label={createCollaborationTranslator(locale)('todo.issue_details')}
            conversation={
              taskComposer?.issue.id === personalIssue.issue.id ? conversationPanel : null
            }
            conversationKey={taskComposer?.conversationKey}
            onClose={() => {
              closeTaskConversation()
              personalIssue.onClose?.()
            }}
            onCloseConversation={closeTaskConversation}
          >
            {closeDrawers => (
              <PersonalHomeIssuePanel
                {...personalIssue}
                onClose={closeDrawers}
                api={scopedApi}
                renderDetail={context => renderIssueEditor(context, closeDrawers)}
                refreshKey={refreshProjectRequestKey}
                onCreateTask={runtimePort ? issue => openNewTaskConversation(issue) : undefined}
              />
            )}
          </IssueConversationDrawers>
        ) : (
          <>
            <CollaborationApp
              participationUserId={
                project.project_store === 'local'
                  ? (services.localParticipationIdentity?.viewerUserIds ?? taskOwnerUserId)
                  : taskOwnerUserId
              }
              isIssueRunning={isIssueRunning}
              parentGroupingEnabled
              api={scopedApi}
              initialProject={project}
              onProjectChange={session.projectUpdated}
              host={projectHost}
              locale={locale}
              showProjectBack={false}
              refreshProjectRequestKey={refreshProjectRequestKey}
              issueArchiveEnabled
              normalizePastedFiles={normalizeClipboardImageFiles}
              onPrepareIssueArchive={
                project.project_store === 'local' ? prepareIssueArchive : undefined
              }
              onCreateTask={
                runtimePort
                  ? async (_taskProject, issue) => openNewTaskConversation(issue)
                  : undefined
              }
              renderIssueDetail={renderIssueDetail}
              renderBoardIssueCard={({
                metadata,
                childrenAction,
                display,
                focused,
                issue,
                onOpen,
                onDelete,
                onMarkRead,
                taskBindings,
              }) => {
                const boardTaskBindings = taskBindings.map(
                  binding =>
                    ({
                      id: binding.id,
                      device_id: binding.deviceId,
                      task_id: binding.taskId,
                      task_title: binding.taskTitle,
                      running:
                        runtimeRunningByAddress.get(
                          runtimeConversationKey({
                            deviceId: binding.deviceId,
                            taskId: binding.taskId,
                          })
                        ) ?? false,
                      modelSelection: binding.modelSelection,
                      executionContext: binding.executionContext,
                      runtimeAddress: workspaceExecutionAddress(
                        binding,
                        runtimeWork,
                        issue.id,
                        project.project_store
                      ),
                      runtimeTask: findRuntimeTask(runtimeWork, {
                        deviceId: binding.deviceId,
                        taskId: binding.taskId,
                      }),
                    }) as CloudTodoBoardTaskBinding
                )
                return (
                  <div className="w-full" data-testid={collaborationTestIds.issue(issue.id)}>
                    <CloudTodoBoardCard
                      projectStore={project.project_store}
                      metadata={metadata}
                      childrenAction={childrenAction}
                      item={
                        {
                          ...issue,
                          project_store: project.project_store,
                        } as unknown as CloudLoopItem
                      }
                      taskBindings={boardTaskBindings}
                      getRuntimeTranscript={services.runtimeWorkApi?.getRuntimeTranscript}
                      unread={false}
                      onClick={onOpen}
                      onArchive={onDelete ?? (() => undefined)}
                      archiveLabel={t('todo.archive_issue', '归档任务')}
                      onMarkRead={onMarkRead}
                      issueDetailOnly
                      onOpenRuntimeTask={
                        runtimePort
                          ? address => {
                              void openBoundTaskConversation(issue, address)
                            }
                          : onOpenRuntimeTask
                      }
                      display={display}
                      archiveDisabled={!onDelete}
                      progressDisplay={focused ? 'focused' : 'compact'}
                      renderBadges={badges => (
                        <IssueChangeRequestBadges
                          badges={badges}
                          monitor={issueChangeRequestMonitor}
                          compact
                          testId={`cloud-todo-card-badges-${issue.id}`}
                        />
                      )}
                    />
                  </div>
                )
              }}
            />
          </>
        )}
      </div>
      {projectChatOpen && (
        <ProjectSpaceChatSidebar
          key={`${project.project_store}:${project.id}:${conversationRequestKey}`}
          project={editorProject}
          localProjects={localProjects}
          localExecution
          startNew
          onClose={() => setClosedConversationRequestKey(conversationRequestKey)}
        />
      )}
    </div>
  )
}
