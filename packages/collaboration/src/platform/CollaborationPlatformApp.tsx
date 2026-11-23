import { Button as ControlButton } from '../markdown/Button'
import { PlatformInvitedIssueAccess } from './PlatformInvitedIssueAccess'
import { useInvitedIssueRoute } from './useInvitedIssueRoute'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { IssueHomeLauncher } from './PlatformIssueHomeLauncher'
import { RootTeamEditor } from './PlatformRootTeamEditor'
import { WorkspaceProjectPicker } from './PlatformWorkspaceViews'
import { renderPlatformWorkspaceContent } from './PlatformWorkspaceContent'
import { renderPlatformProjectCreateDialog } from './PlatformProjectCreateDialog'
import { PageHeader, EmptyState, FirstWorkStarter, WorkItemsPage } from './PlatformWorkspaceViews'
import { createWorkspaceAgentConfigurationApi } from './platformWorkspaceAgentApi'
import { usePlatformCreationState } from './usePlatformCreationState'
import { createPlatformIssueCreationState } from './platformIssueCreationState'
import { CollaborationTemplateContext } from '../templates/context'
import { CollaborationTemplatePage } from '../templates/CollaborationTemplatePage'
import { useDeviceCatalog } from './useDeviceCatalog'
import { platformMessages } from './platformMessages'
import { ResourceCatalogPage } from './ResourceCatalogPage'
import type { ResourceCatalogKind, ResourceSource } from './resourceCatalogModel'
import { CollaborationApp } from '../CollaborationApp'
import { ProjectLoadingSkeleton } from '../project-shell'
import { ProjectArchiveDialog } from './ProjectArchiveDialog'
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog'
import { createCollaborationTranslator } from '../i18n'
import type { WorkspaceMyWorkItem } from '../ports/SharedWorkspaceApi'
import type { CollaborationOwnedAgent, CollaborationProject } from '../types'
import type {
  CollaborationDomain,
  CollaborationPlatformHostAdapter,
  CollaborationPlatformLocation,
  CollaborationWorkspaceView,
} from './types'
import { CollaborationPlatformNavigation } from './CollaborationPlatformNavigation'
import { useCollaborationPlatformController } from './useCollaborationPlatformController'
import { isCurrentDeviceCollaborationAgent } from './useGroupConfiguration'
import { workspaceIssueOperationState } from './workspaceOperations'

export type {
  CollaborationProjectRendererContext,
  CollaborationProjectRendererWorkspaceContext,
} from './platformAppTypes'
import type { CollaborationPlatformAppProps } from './platformAppTypes'

function navigateWithin(
  host: CollaborationPlatformHostAdapter,
  patch: Partial<CollaborationPlatformLocation>
) {
  const location = { ...host.location, ...patch }
  if (patch.projectView && patch.projectView !== 'manage') {
    location.projectSettingsSection = null
  }
  host.navigate(location)
}

export function CollaborationPlatformApp(
  props: React.ComponentProps<typeof CollaborationPlatformAppContent>
) {
  return (
    <CollaborationTemplateContext.Provider
      key={props.host.accountScope}
      value={props.host.templateStore ?? null}
    >
      <CollaborationPlatformAppContent {...props} />
    </CollaborationTemplateContext.Provider>
  )
}

function CollaborationPlatformAppContent({
  api,
  refreshKey,
  navigationApis,
  host,
  locale = 'zh-CN',
  onCreateTask,
  onReady,
  renderProject,
  renderShell,
  sidebarFooter,
  normalizePastedFiles,
}: CollaborationPlatformAppProps) {
  const messages = platformMessages[locale]
  const translate = createCollaborationTranslator(locale)
  const isDevicePage =
    !host.location.projectId && !host.location.workspaceId && host.location.rootView === 'devices'
  const isStandInPage =
    !host.location.projectId &&
    !host.location.workspaceId &&
    host.location.rootView === 'stand-in' &&
    Boolean(host.renderStandInPage)
  const isTemplatePage =
    !host.location.projectId &&
    !host.location.workspaceId &&
    host.location.rootView === 'templates' &&
    Boolean(host.templateStore)
  const isPersonalIssuesPage =
    !host.location.projectId &&
    !host.location.workspaceId &&
    Boolean(host.renderIssueList) &&
    Boolean(host.location.rootView?.startsWith('issues-'))
  const isIssuePage = Boolean(host.location.projectId && host.location.issueId)
  const ownsPageRequests =
    isDevicePage || isStandInPage || isTemplatePage || isPersonalIssuesPage || isIssuePage
  const deviceCatalog = useDeviceCatalog(api, isDevicePage, refreshKey, host.currentUser)
  const { state, commands } = useCollaborationPlatformController({
    api,
    navigationApis,
    location: host.location,
    loadFailedMessage: messages.loadFailed,
    refreshKey,
  })
  const {
    creation,
    workspaceDialogOpen,
    projectDialogOpen,
    standaloneProjectLocation,
    projectTemplate,
    projectImporter,
    projectWorkspaceId,
    projectWorkspaceMembers,
    projectWorkspaceAgents,
    projectWorkspaceGroups,
    projectCreationResources,
    projectEnvironmentLoading,
    projectEnvironmentError,
    workspacePickerOpen,
  } = usePlatformCreationState(api, { state, commands, host, messages, ownsPageRequests, onReady })
  const { openWorkspaceProjectCreator, startProjectCreation, startStandaloneProjectCreation } =
    creation
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [archiveProject, setArchiveProject] = useState<CollaborationProject | null>(null)
  const [workspaceGroupCreationRequested, setWorkspaceGroupCreationRequested] = useState(false)
  const [rootAgentForm, setRootAgentForm] = useState<{
    mode: 'create' | 'edit'
    source: ResourceSource
    namespace: string
    ownerLabel: string
    ownerOptions?: Array<{ namespace: string; label: string }>
    resourceId?: string
    teamId?: number
  } | null>(null)
  const [rootDeviceCreator, setRootDeviceCreator] = useState<{
    source: ResourceSource
    workspaceId?: string
  } | null>(null)
  const [rootTeamCreationWorkspaceId, setRootTeamCreationWorkspaceId] = useState<string | null>(
    null
  )
  const [rootTeamEditingId, setRootTeamEditingId] = useState<string>()
  const [rootIssueProjectId, setRootIssueProjectId] = useState<string | null>(null)
  const projectWorkspace =
    projectWorkspaceId == null
      ? null
      : (state.workspaces.find(workspace => workspace.id === projectWorkspaceId) ??
        (state.workspace?.id === projectWorkspaceId ? state.workspace : null))
  const projectImporterWorkspace =
    projectImporter == null
      ? null
      : (state.workspaces.find(workspace => workspace.id === projectImporter.workspaceId) ??
        (state.workspace?.id === projectImporter.workspaceId ? state.workspace : null))
  const projectWorkspaceOwnerLabel =
    projectWorkspace == null
      ? null
      : (host.workspaceOwnerOptions?.find(option => option.namespace === projectWorkspace.namespace)
          ?.label ??
        (projectWorkspace.namespace === 'default'
          ? messages.personalOwner
          : projectWorkspace.namespace))
  const defaultProjectWorkspace = state.workspaces.find(
    workspace =>
      workspace.location === 'cloud' &&
      workspace.is_system_default &&
      workspace.access_role === 'Owner'
  )
  const projectCreateLocation =
    projectWorkspace?.location ??
    (host.capabilities.projectNavigation === 'projects'
      ? standaloneProjectLocation
      : (host.capabilities.projectLocation ?? 'cloud'))
  const workspaceLocations = host.capabilities.workspaceLocations ?? ['cloud']
  const canCreateCloudWorkspace = workspaceLocations.includes('cloud')
  const collaborationDomain: CollaborationDomain =
    host.location.collaborationDomain ??
    state.workspace?.location ??
    (host.capabilities.projectLocation === 'local' ? 'local' : 'cloud')
  const domainWorkspaces = state.workspaces
  const domainWorkspaceIds = useMemo(
    () => new Set(domainWorkspaces.map(workspace => workspace.id)),
    [domainWorkspaces]
  )
  const domainProjects = useMemo(
    () =>
      state.projects.filter(
        project =>
          host.capabilities.projectNavigation === 'projects' ||
          (Boolean(project.workspace_id) && domainWorkspaceIds.has(project.workspace_id!))
      ),
    [domainWorkspaceIds, state.projects, host.capabilities.projectNavigation]
  )
  const selectedRootProjectId = host.issueHomeDraft
    ? host.issueHomeDraft.projectId
    : rootIssueProjectId
  const rootIssueProject = selectedRootProjectId
    ? (domainProjects.find(project => project.id === selectedRootProjectId) ?? null)
    : (domainProjects[0] ?? null)
  const scopedApi = useMemo(
    () => creation.scopedApi(host.location.workspaceId, host.location.projectId),
    [creation, host.location.projectId, host.location.workspaceId]
  )
  const issueCreation = useMemo(() => createPlatformIssueCreationState(api), [api])
  const issueCreationInput = useMemo(
    () => ({ host, project: rootIssueProject, messages }),
    [host, rootIssueProject, messages]
  )
  const subscribeIssueCreation = useCallback(
    (listener: () => void) => issueCreation.subscribe(issueCreationInput, listener),
    [issueCreation, issueCreationInput]
  )
  const { rootIssueLoading, createdHomeIssue, standInRetry, standInRetrying } =
    useSyncExternalStore(
      subscribeIssueCreation,
      issueCreation.getSnapshot,
      issueCreation.getSnapshot
    )
  const { startRootIssueCreation } = issueCreation
  const invitedIssueRoute = useInvitedIssueRoute({
    api: scopedApi,
    projectId: host.location.projectId,
    issueId: host.location.issueId,
    projectReady: state.projects.some(project => String(project.id) === host.location.projectId),
    enabled: Boolean(renderProject),
    failureLabel: messages.loadFailed,
  })
  const invitedRouteMatches = invitedIssueRoute.invited
  const workspaceAgentConfigurationApi = useMemo(
    () =>
      host.location.workspaceId
        ? createWorkspaceAgentConfigurationApi(api, host.location.workspaceId)
        : api,
    [api, host.location.workspaceId]
  )
  const projectResourceAgents = useMemo(() => {
    const agents = new Map<string, CollaborationOwnedAgent>()
    for (const agent of [
      ...state.resources.agents,
      ...state.agents,
      ...projectWorkspaceAgents,
      ...projectCreationResources.agents,
    ]) {
      agents.set(agent.id, agent)
    }
    return [...agents.values()]
  }, [
    projectWorkspaceAgents,
    projectCreationResources.agents,
    state.agents,
    state.resources.agents,
  ])
  const selectedProjectResourceAgents = projectResourceAgents
  const defaultProjectAgentResourceIds = useMemo(
    () =>
      selectedProjectResourceAgents
        .filter(isCurrentDeviceCollaborationAgent)
        .map(agent => agent.id),
    [selectedProjectResourceAgents]
  )
  const openProject = (project: CollaborationProject) => {
    const workspace =
      state.workspaces.find(candidate => candidate.id === project.workspace_id) ?? null
    navigateWithin(host, {
      collaborationDomain:
        workspace?.location ?? (project.project_store === 'local' ? 'local' : 'cloud'),
      workspaceId: project.workspace_id,
      workspaceView: 'projects',
      projectId: project.id,
      projectView: 'board',
      issueId: null,
    })
  }
  const openMyWorkItem = (item: WorkspaceMyWorkItem) => {
    const project = state.projects.find(candidate => candidate.id === item.cloud_project_id)
    if (!project) return
    navigateWithin(host, {
      collaborationDomain: project.project_store === 'local' ? 'local' : 'cloud',
      workspaceId: project.workspace_id ?? null,
      workspaceView: 'projects',
      projectId: project.id,
      projectView: 'board',
      issueId: item.id,
    })
  }
  const openResourceWorkspace = (workspaceId: string, kind: ResourceCatalogKind) => {
    const workspaceViews: Record<ResourceCatalogKind, CollaborationWorkspaceView> = {
      agents: 'agents',
      teams: 'collaboration-groups',
      devices: 'execution-environments',
    }
    navigateWithin(host, {
      workspaceId,
      workspaceView: workspaceViews[kind],
      projectId: null,
      projectView: 'board',
      issueId: null,
    })
  }
  const bindRootResource = async (
    workspaceId: string,
    kind: ResourceCatalogKind,
    resourceId: string
  ) => {
    if (!api.workspaces) throw new Error('Workspace API is unavailable')
    try {
      if (kind === 'agents') {
        const agent = state.resources.agents.find(candidate => candidate.id === resourceId)
        if (agent?.location === 'local') {
          const workspace = state.workspaces.find(candidate => candidate.id === workspaceId)
          if (workspace?.location !== 'local') {
            throw new Error(
              locale === 'zh-CN'
                ? '本地智能体只能在本地分组中使用'
                : 'Local Agents can only be used in the local space'
            )
          }
          host.notify?.(messages.bindingsSaved, 'success')
          return
        }
        if (!agent?.team_id) throw new Error('Agent cannot be authorized')
        await api.workspaces.addAgent(workspaceId, { teamId: agent.team_id })
      } else if (kind === 'devices') {
        const environment = (
          isDevicePage ? deviceCatalog.items : state.resources.execution_environments
        ).find(candidate => candidate.id === resourceId)
        if (!environment?.device_id) {
          throw new Error('Execution environment cannot be authorized')
        }
        await api.workspaces.addExecutionEnvironment(workspaceId, {
          deviceId: environment.device_id,
        })
      } else {
        openResourceWorkspace(workspaceId, kind)
        return
      }
      if (!creation.isAccountCurrent()) return
      await commands.reload()
      if (!creation.isAccountCurrent()) return
      host.notify?.(messages.bindingsSaved, 'success')
    } catch (error) {
      if (creation.isAccountCurrent())
        host.notify?.(error instanceof Error ? error.message : messages.loadFailed, 'error')
      throw error
    }
  }
  const manageRootResource = (
    kind: ResourceCatalogKind,
    resourceId?: string,
    source?: ResourceSource
  ) => {
    if (kind === 'devices') {
      host.manageResource?.('environments', resourceId, source)
      return
    }
    if (kind === 'teams') {
      const group = state.collaborationGroups.find(candidate => candidate.id === resourceId)
      if (group) {
        if (group.owner_type === 'project') {
          const project = state.navigationProjects.find(
            candidate => candidate.id === group.owner_id
          )
          if (project) {
            host.navigate({
              platformView: 'spaces',
              rootView: 'home',
              workspaceId: project.workspace_id ?? group.workspace_id,
              workspaceView: 'projects',
              projectId: project.id,
              projectView: 'manage',
              issueId: null,
            })
          }
          return
        }
        setRootTeamEditingId(group.id)
        setRootTeamCreationWorkspaceId(group.workspace_id)
      }
      return
    }
    const agent = state.resources.agents.find(candidate => candidate.id === resourceId)
    if (agent?.location === 'local') {
      if (host.projectAgentConfiguration?.renderProjectAgentEditor) {
        setRootAgentForm({
          mode: 'edit',
          source: 'local',
          namespace: 'default',
          ownerLabel: agent.owner_name,
          resourceId: agent.id,
        })
      }
      return
    }
    if (!agent?.team_id || !host.projectAgentConfiguration?.renderAgentEditor) {
      host.manageResource?.('agents', resourceId)
      return
    }
    const ownerLabel =
      host.workspaceOwnerOptions?.find(option => option.namespace === agent.owner_id)?.label ??
      agent.owner_name
    setRootAgentForm({
      mode: 'edit',
      source: agent.location ?? 'cloud',
      namespace: agent.owner_type === 'user' ? 'default' : agent.owner_id,
      ownerLabel,
      teamId: agent.team_id,
    })
  }
  let content: React.ReactNode
  if (state.loading && !ownsPageRequests) {
    content = (
      <ProjectLoadingSkeleton
        label={translate('common.loading', '正在加载…')}
        layout={host.location.projectId && host.location.projectView === 'board' ? 'board' : 'list'}
      />
    )
  } else if (state.error && !ownsPageRequests) {
    content = (
      <div className="collaboration-alert" role="alert">
        {state.error}
      </div>
    )
  } else if (
    host.location.projectId &&
    (isIssuePage ||
      state.workspace ||
      state.workspaceNavigationContext ||
      state.projects.some(
        project => String(project.id) === host.location.projectId && !project.workspace_id
      ))
  ) {
    const workspaceContext = state.workspace ?? state.workspaceNavigationContext
    const selectedProject =
      state.projects.find(project => String(project.id) === host.location.projectId) ?? null
    content =
      renderProject && isIssuePage && !selectedProject && !invitedRouteMatches ? (
        <PlatformInvitedIssueAccess
          error={invitedIssueRoute.error}
          loadError={state.error}
          retry={invitedIssueRoute.retry}
          translate={translate}
        />
      ) : selectedProject && renderProject && !invitedRouteMatches ? (
        renderProject({ project: selectedProject, workspace: workspaceContext })
      ) : (
        <CollaborationApp
          parentGroupingEnabled
          api={scopedApi}
          initialProject={selectedProject ?? undefined}
          issueArchiveEnabled
          normalizePastedFiles={normalizePastedFiles}
          locale={locale}
          onProjectChange={commands.registerProject}
          showProjectBack={false}
          host={{
            settingsPages: host.settingsPages,
            capabilities: {
              automation: host.capabilities.automation,
              dingtalkAitable: host.capabilities.dingtalkAitable,
              projectLocation: host.capabilities.projectLocation,
            },
            location: {
              projectId: host.location.projectId,
              issueId: host.location.issueId,
              view: host.location.projectView,
              projectSettingsSection: host.location.projectSettingsSection,
            },
            navigate: location =>
              navigateWithin(host, {
                projectId: location.projectId,
                issueId: location.issueId,
                projectView: location.view,
                projectSettingsSection: location.projectSettingsSection,
                workspaceView: 'projects',
              }),
            notify: host.notify,
            openExternal: host.openExternal,
            manageResource: host.manageResource,
            projectAgentConfiguration: host.projectAgentConfiguration,
            projectAgentResourceContext: {
              name: workspaceContext?.name ?? selectedProject?.name ?? '',
              namespace:
                workspaceContext && 'namespace' in workspaceContext
                  ? workspaceContext.namespace
                  : 'default',
            },
            defaultAssistant: host.defaultAssistant,
          }}
          onCreateTask={onCreateTask}
        />
      )
  } else if (host.location.projectId) {
    // Opening one project holds the frame instead of painting the workspace
    // home while the project's workspace is still on its way.
    content = (
      <div
        className="collaboration-platform-panel flex min-h-32 items-center justify-center p-6 text-sm text-text-secondary"
        data-testid="collaboration-platform-opening-project"
        role="status"
      >
        {messages.loading}
      </div>
    )
  } else if (
    !state.workspace ||
    isDevicePage ||
    isTemplatePage ||
    host.location.rootView === 'stand-in'
  ) {
    const rootView = host.location.rootView ?? 'home'
    const inboxItems = state.myWork.filter(item => {
      const operation = workspaceIssueOperationState(item)
      return item.is_unread || operation === 'failed' || operation === 'review'
    })
    content =
      rootView === 'templates' && host.templateStore ? (
        <CollaborationTemplatePage
          key={host.templateStore.library.scope}
          store={host.templateStore}
          locale={locale}
          onUse={record => {
            creation.useTemplate(record.document)
          }}
        />
      ) : rootView === 'stand-in' && host.renderStandInPage ? (
        host.renderStandInPage({
          projects: state.navigationProjects,
          onClose: () =>
            host.navigate({
              ...host.location,
              rootView: 'home',
              workspaceId: null,
              projectId: null,
              issueId: null,
            }),
        })
      ) : rootView === 'agents' || rootView === 'teams' || rootView === 'devices' ? (
        <ResourceCatalogPage
          api={api}
          domain={collaborationDomain}
          cloudAccess={host.cloudAccess}
          kind={rootView}
          agents={state.resources.agents}
          groups={state.collaborationGroups}
          environments={
            rootView === 'devices' ? deviceCatalog.items : state.resources.execution_environments
          }
          deviceCatalog={rootView === 'devices' ? deviceCatalog : undefined}
          preferences={
            rootView === 'devices' ? host.renderExecutionEnvironmentPreferences?.() : undefined
          }
          locale={locale}
          currentUserId={host.currentUser?.id}
          onDeleteDevice={
            api.resources?.removeDevice
              ? async device => {
                  try {
                    await api.resources!.removeDevice!(device)
                    if (creation.isAccountCurrent()) deviceCatalog.remove(device.id)
                  } catch (error) {
                    if (creation.isAccountCurrent()) void deviceCatalog.refreshCloud()
                    throw error
                  }
                }
              : undefined
          }
          translate={translate}
          canCreateDevice={Boolean(host.renderDeviceCreator)}
          workspaces={state.workspaces}
          projects={state.navigationProjects}
          ownerOptions={host.workspaceOwnerOptions}
          messages={messages}
          onAddToWorkspace={bindRootResource}
          onCreateAgent={ownerOptions =>
            setRootAgentForm({
              mode: 'create',
              source: 'cloud',
              namespace: 'default',
              ownerLabel:
                ownerOptions.find(owner => owner.namespace === 'default')?.label ??
                messages.personalOwner,
              ownerOptions,
            })
          }
          onCreateDevice={(source, workspaceId) => setRootDeviceCreator({ source, workspaceId })}
          onCreateLocalAgent={() =>
            setRootAgentForm({
              mode: 'create',
              source: 'local',
              namespace: 'default',
              ownerLabel: messages.localWorkspaceResource,
            })
          }
          onCreateTeam={workspaceId => {
            setRootTeamEditingId(undefined)
            setRootTeamCreationWorkspaceId(workspaceId)
          }}
          onDeleteAgent={async agent => {
            if (!api.resources?.removeAgent) {
              throw new Error(messages.deleteFailed)
            }
            await api.resources.removeAgent(agent)
            if (!creation.isAccountCurrent()) return
            await commands.reload()
          }}
          onDeleteTeam={async group => {
            if (group.owner_type === 'project') {
              if (!api.projects.removeCollaborationGroup) {
                throw new Error(messages.deleteFailed)
              }
              await api.projects.removeCollaborationGroup(group.owner_id, group.id)
            } else {
              if (!api.workspaces) {
                throw new Error(messages.deleteFailed)
              }
              await api.workspaces.removeCollaborationGroup(group.workspace_id, group.id)
            }
            await commands.reload()
          }}
          onManageResource={manageRootResource}
        />
      ) : rootView.startsWith('issues-') && host.renderIssueList ? (
        host.renderIssueList({
          scope:
            rootView === 'issues-created'
              ? 'created'
              : rootView === 'issues-assigned'
                ? 'assigned'
                : 'participating',
          projects: state.navigationProjects,
          onOpenIssue: openMyWorkItem,
        })
      ) : rootView === 'inbox' ? (
        <WorkItemsPage
          title={messages.inbox}
          subtitle={messages.needsYourAction}
          empty={messages.noInboxItems}
          items={inboxItems}
          locale={locale}
          messages={messages}
          onOpenItem={openMyWorkItem}
        />
      ) : (
        <div
          className={
            host.renderIssueComposer && domainProjects.length
              ? 'collaboration-task-home-page'
              : 'collaboration-platform-page collaboration-home-page'
          }
        >
          {!domainWorkspaces.length &&
          !host.createIndependentIssue &&
          host.capabilities.projectNavigation !== 'projects' ? (
            <>
              <PageHeader title={messages.issueHomeTitle} subtitle={messages.issueHomeHint} />
              <EmptyState
                title={messages.noSpaces}
                description={messages.noSpacesHint}
                action={
                  canCreateCloudWorkspace ? (
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      className="collaboration-primary-button"
                      onClick={creation.openWorkspaceDialog}
                    >
                      {messages.createWorkspace}
                    </ControlButton>
                  ) : null
                }
              />
            </>
          ) : !domainProjects.length ? (
            <FirstWorkStarter
              onCreateIssue={host.createIndependentIssue}
              messages={messages}
              supportsLocalImport={Boolean(
                host.renderProjectImporter &&
                domainWorkspaces.some(workspace => workspace.location === 'local')
              )}
              onCreate={startProjectCreation}
            />
          ) : (
            <IssueHomeLauncher
              draft={host.issueHomeDraft}
              renderTaskComposer={
                host.renderIssueComposer
                  ? props =>
                      host.renderIssueComposer!({
                        ...props,
                        onTaskCreated: (issue, task) => {
                          const project = props.projects.find(item => item.id === props.projectId)
                          if (!project) return
                          issueCreation.recordCreatedTask(project, issue, task)
                        },
                      })
                  : undefined
              }
              currentUserId={
                host.renderPersonalHome
                  ? (rootIssueProject?.current_user_id ?? host.currentUser?.id)
                  : undefined
              }
              api={api}
              locale={locale}
              messages={messages}
              projects={domainProjects}
              selectedProjectId={rootIssueProject?.id ?? ''}
              workspaces={domainWorkspaces}
              onSelectProject={host.issueHomeDraft?.onSelectProject ?? setRootIssueProjectId}
              pending={rootIssueLoading}
              onCreateIssue={(content, memberIds, files, standInDeviceId, standInId) =>
                startRootIssueCreation(content, memberIds, files, standInDeviceId, standInId)
              }
              onOpenExecutionEnvironments={project =>
                navigateWithin(host, {
                  workspaceId: project.workspace_id ?? null,
                  workspaceView: 'projects',
                  projectId: project.id,
                  projectView: 'manage',
                  projectSettingsSection: 'environments',
                  issueId: null,
                })
              }
            />
          )}
        </div>
      )
    if (rootView === 'home' && host.renderPersonalHome) {
      content = host.renderPersonalHome({
        contentVisible: !mobileNavigationOpen,
        projects: state.navigationProjects,
        createIssue: content,
        createdIssue: createdHomeIssue,
        onCreatedIssueHandled: issueCreation.acknowledgeCreatedIssue,
        onOpenIssue: openMyWorkItem,
      })
    }
  } else {
    content = renderPlatformWorkspaceContent({
      workspace: state.workspace,
      creation,
      openProject,
      state,
      commands,
      host,
      api,
      messages,
      locale,
      translate,
      workspaceAgentConfigurationApi,
      workspaceGroupCreationRequested,
      setWorkspaceGroupCreationRequested,
      openWorkspaceProjectCreator,
    })
  }

  const sidebar = (
    <CollaborationPlatformNavigation
      mobileNavigationOpen={mobileNavigationOpen}
      onMobileNavigationOpenChange={setMobileNavigationOpen}
      domain={collaborationDomain}
      host={host}
      messages={messages}
      workspaces={state.workspaces}
      workspaceNavigationContext={state.workspaceNavigationContext}
      projects={state.navigationProjects}
      navigationIncomplete={
        state.navigationIncomplete || (ownsPageRequests && Boolean(state.error))
      }
      onRetryNavigation={commands.reload}
      canCreateWorkspace={canCreateCloudWorkspace}
      onCreateWorkspace={() => {
        creation.openWorkspaceDialog()
      }}
      onCreateProject={openWorkspaceProjectCreator}
      onCreateStandaloneProject={startStandaloneProjectCreation}
      onArchiveProject={setArchiveProject}
      footer={sidebarFooter}
    />
  )
  const main = (
    <main className="collaboration-platform-main">
      {standInRetry && (
        <div
          role="alert"
          data-testid="stand-in-run-error"
          className="flex items-center gap-2 p-3 text-sm text-text-secondary"
        >
          <span>
            {createCollaborationTranslator(locale)('standIn.start_failed')} {standInRetry.error}
          </span>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="stand-in-run-retry"
            disabled={standInRetrying}
            onClick={() => void issueCreation.retryStandIn()}
            className="shrink-0 rounded-md px-2 py-1 hover:bg-muted"
          >
            {createCollaborationTranslator(locale)('standIn.retry')}
          </ControlButton>
        </div>
      )}
      {content}
      {archiveProject && (
        <ProjectArchiveDialog
          project={archiveProject}
          locale={locale}
          onClose={() => setArchiveProject(null)}
          onArchive={() => creation.archiveProject(archiveProject)}
        />
      )}
    </main>
  )

  return (
    <section
      className={renderShell ? undefined : 'collaboration-platform-app'}
      data-testid="collaboration-platform-root"
      style={renderShell ? { height: '100%', minHeight: 0 } : undefined}
    >
      {renderShell ? (
        renderShell({
          main,
          sidebar,
          mobileNavigation: { open: mobileNavigationOpen, setOpen: setMobileNavigationOpen },
        })
      ) : (
        <>
          {sidebar}
          {main}
        </>
      )}
      {workspaceDialogOpen ? (
        <WorkspaceCreateDialog
          messages={messages}
          ownerOptions={host.workspaceOwnerOptions}
          onClose={creation.closeWorkspaceDialog}
          onCreate={creation.createWorkspace}
        />
      ) : null}
      {workspacePickerOpen ? (
        <WorkspaceProjectPicker
          messages={messages}
          workspaces={domainWorkspaces}
          cloudAccess={host.cloudAccess}
          canCreateCloudWorkspace={canCreateCloudWorkspace}
          onClose={creation.closeWorkspacePicker}
          onCreateCloudWorkspace={creation.createPickerWorkspace}
          onSelect={creation.selectPickerWorkspace}
        />
      ) : null}
      {projectImporterWorkspace && host.renderProjectImporter
        ? host.renderProjectImporter({
            workspace: projectImporterWorkspace,
            mode: projectImporter?.mode ?? 'folder',
            projects: state.navigationProjects.filter(
              project => project.workspace_id === projectImporterWorkspace.id
            ),
            onClose: () => creation.closeImporter(),
            onImported: async project => {
              if (!creation.isAccountCurrent()) return
              creation.closeImporter()
              commands.registerProject(project)
              openProject(project)
            },
          })
        : null}
      {renderPlatformProjectCreateDialog({
        api,
        creation,
        commands,
        state,
        host,
        locale,
        messages,
        projectDialogOpen,
        projectTemplate,
        projectCreateLocation,
        projectWorkspaceId,
        defaultProjectWorkspace,
        projectWorkspace,
        projectWorkspaceOwnerLabel,
        projectWorkspaceMembers,
        selectedProjectResourceAgents,
        defaultProjectAgentResourceIds,
        projectWorkspaceGroups,
        projectCreationResources,
        projectEnvironmentLoading,
        projectEnvironmentError,
      })}
      {rootAgentForm?.mode === 'create' &&
      rootAgentForm.source === 'local' &&
      host.projectAgentConfiguration?.renderLocalAgentCreator
        ? host.projectAgentConfiguration.renderLocalAgentCreator({
            onClose: () => setRootAgentForm(null),
            onCreated: async () => {
              if (!creation.isAccountCurrent()) return
              setRootAgentForm(null)
              await creation.resourceSaved(true)
            },
          })
        : null}
      {rootAgentForm?.mode === 'create' &&
      rootAgentForm.source === 'cloud' &&
      host.projectAgentConfiguration?.renderAgentCreator
        ? host.projectAgentConfiguration.renderAgentCreator({
            namespace: rootAgentForm.namespace,
            ownerOptions: rootAgentForm.ownerOptions,
            workspaceName: rootAgentForm.ownerLabel,
            onClose: () => setRootAgentForm(null),
            onCreated: async () => {
              if (!creation.isAccountCurrent()) return
              setRootAgentForm(null)
              await creation.resourceSaved(true)
            },
          })
        : null}
      {rootAgentForm?.mode === 'edit' &&
      rootAgentForm.source === 'local' &&
      host.projectAgentConfiguration?.renderProjectAgentEditor
        ? host.projectAgentConfiguration.renderProjectAgentEditor({
            resourceId: rootAgentForm.resourceId ?? '',
            onClose: () => setRootAgentForm(null),
            onSaved: async () => {
              if (!creation.isAccountCurrent()) return
              setRootAgentForm(null)
              await creation.resourceSaved()
            },
          })
        : null}
      {rootDeviceCreator && host.renderDeviceCreator
        ? host.renderDeviceCreator({
            source: rootDeviceCreator.source,
            workspaceId: rootDeviceCreator.workspaceId,
            hasCloudDevice: deviceCatalog.items.some(
              environment => environment.kind === 'cloud_host'
            ),
            onClose: () => setRootDeviceCreator(null),
            onCreated: async deviceId => {
              if (!creation.isAccountCurrent()) return
              if (deviceId && rootDeviceCreator.workspaceId && api.workspaces) {
                await api.workspaces.addExecutionEnvironment(rootDeviceCreator.workspaceId, {
                  deviceId,
                })
              }
              if (!creation.isAccountCurrent()) return
              setRootDeviceCreator(null)
              await deviceCatalog.refresh()
              await creation.resourceSaved()
            },
          })
        : null}
      {rootTeamCreationWorkspaceId
        ? (() => {
            const workspace = state.workspaces.find(
              candidate => candidate.id === rootTeamCreationWorkspaceId
            )
            if (!workspace) return null
            return (
              <RootTeamEditor
                key={rootTeamEditingId ?? 'create'}
                groupId={rootTeamEditingId}
                api={api}
                host={host}
                workspace={workspace}
                groups={state.collaborationGroups.filter(
                  group => group.workspace_id === workspace.id
                )}
                locale={locale}
                onClose={() => setRootTeamCreationWorkspaceId(null)}
                onCreated={async () => {
                  await creation.resourceSaved()
                }}
              />
            )
          })()
        : null}
      {rootAgentForm?.mode === 'edit' &&
      rootAgentForm.source === 'cloud' &&
      rootAgentForm.teamId &&
      host.projectAgentConfiguration?.renderAgentEditor
        ? host.projectAgentConfiguration.renderAgentEditor({
            agent: { teamId: rootAgentForm.teamId },
            namespace: rootAgentForm.namespace,
            workspaceName: rootAgentForm.ownerLabel,
            onClose: () => setRootAgentForm(null),
            onSaved: async () => {
              if (!creation.isAccountCurrent()) return
              setRootAgentForm(null)
              await creation.resourceSaved()
            },
          })
        : null}
    </section>
  )
}
