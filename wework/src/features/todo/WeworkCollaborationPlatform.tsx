import { prepareIssueRuntimeArchive } from './prepareIssueRuntimeArchive'
import {
  GroupThreadPersonalTaskController,
  GroupThreadSurface,
} from '@/features/collaboration/GroupThreadPersonalTaskController'
import { threadWorkOwner } from '@/features/collaboration/threadPersonalTaskAccess'
import type { ThreadArchivePreparationContext } from '@/features/collaboration/threadActions'
import { issueRuntimeBindingPort } from './issueRuntimeBindingPort'
import {
  useIssuePersonalTaskState,
  useIssuePersonalTaskConversation,
  type IssueRuntimeBindingPort,
} from './useIssuePersonalTaskConversation'
import { workspaceExecutionAddress, issueExecutionAddress } from './collaborationTaskAddress'
import { IssueChangeRequestBadges } from '@/features/change-requests/IssueChangeRequestBadges'
import { type GroupSource } from '@/features/collaboration/CollaborationGroupsSurface'
import { CollaborationViewSwitcher } from '@/features/collaboration/CollaborationViewSwitcher'
import { ThreadCreateDialog } from '@/features/collaboration/ThreadCreateDialog'
import { ThreadCreationHome } from '@/features/collaboration/ThreadCreationHome'
import { useLegacyThreadDestination } from '@/features/collaboration/useLegacyThreadDestination'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import {
  nextBoardReturnOrigin,
  retainBoardReturnOrigin,
  type BoardReturnOrigin,
} from '@/features/collaboration/boardReturnOrigin'
import { Button } from '@/components/ui/button'
import { useStandInProjects } from './useStandInProjects'
import { StandInIcon } from '@wegent/collaboration'
import { bindProjectStandInApi } from '@/api/standIn'
import { WorkspaceRunnerRegistrationDialog } from '@/features/collaboration/WorkspaceRunnerRegistrationDialog'
import { ProjectCoordinatorConversation } from './ProjectCoordinatorConversation'
import { ProjectSpaceChatSidebar } from './ProjectSpaceChatSidebar'
import { MessageSquare } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { StandInPopover } from './StandInPopover'
import { navigateTo, replaceTo } from '@/lib/navigation'
import { createLocalWorkspaceApi, LOCAL_WORKSPACE_ID } from './localWorkspaceApi'
import { createWeworkPlatformApi, withoutDefaultWorkItemProject } from './weworkPlatformApi'
import {
  CollaborationTemplateStore,
  browserTemplatePersistence,
  createCollaborationTemplateRemote,
} from '@wegent/collaboration/templates'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
// eslint-disable-next-line react-refresh/only-export-components
export { createLocalWorkspaceApi, createWeworkPlatformApi }
import {
  Activity,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import {
  CollaborationApp,
  CollaborationPlatformApp,
  createCollaborationTranslator,
  IssueConversationDrawers,
  toSharedIssueDetailTaskBinding,
  type CollaborationHostAdapter,
  type CollaborationIssue,
  type CollaborationPlatformLocation,
  type CollaborationProjectRendererWorkspaceContext,
  type CollaborationProject,
  type SharedWorkspaceApi,
  type WorkspaceTaskBinding,
} from '@wegent/collaboration'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  type CloudLoopItem,
  type CloudProject,
  type LoopItemTaskBinding,
} from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { getChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import { useCollaborationMarkdownServices } from './useCollaborationMarkdownServices'
import { AddCloudDeviceDialog } from '@/components/settings/AddCloudDeviceDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { resolveDeviceResourceSettingsOptions } from './deviceResourceSettings'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import {
  DesktopSidebarAccount,
  type DesktopSidebarAccountSettingsOptions,
} from '@/components/layout/DesktopSidebarAccount'
import { createWeworkProjectAgentConfigurationHost } from '@/features/collaboration/WeworkProjectAgentConfigurationHost'
import { generateCollaborationGroupDraft } from '@/features/collaboration/collaborationGroupDraftGeneration'
import { humanTaskDispatchInput } from './humanTaskDispatch'
import { subscribeIssueDispatch } from '@/features/notifications/issueDispatch'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import type {
  ArchiveRuntimeConversationsResult,
  WorkbenchContextValue,
} from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import type {
  ProjectSpaceDetailServices,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { getNewChatModelSelection } from '@/features/workbench/workbenchProviderHelpers'
import {
  defaultNewChatModelSelection,
  modelSelectionIdentityOptions,
} from '@/features/workbench/runtimeModelSelection'
import { getDefaultModelOptions, getModelDisplayLabel } from '@/lib/model-ui'
import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import { getRuntimeWorkDeviceNamesById, getWorkbenchDeviceNamesById } from '@/lib/workbench-device'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import { runtimeTaskTrackingExecutionStatus } from '@/features/workbench/runtimeTaskLifecycle/projection'
import { WeworkBoardIssueCard } from './WeworkBoardIssueCard'
import {
  runtimeTaskConversationStatusesByAddress,
  issueTaskExecutionStates,
  runtimeTasksRunningByAddress,
} from './runtimeTaskConversationStatus'
import { TodoEditor } from './TodoEditor'
import { WeworkCollaborationEmbeddedBrowserHost } from './WeworkCollaborationEmbeddedBrowserHost'
import {
  projectSpaceForRuntimeTask,
  reconcileProjectSpaceTaskBindings,
  sameProjectSpace,
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
  type LocatedProjectSpace,
} from './projectSpaceSelection'

const initialLocation: CollaborationPlatformLocation = {
  platformView: 'spaces',
  collaborationDomain: 'local',
  workspaceId: null,
  workspaceView: 'home',
  projectId: null,
  projectView: 'board',
  issueId: null,
}

/**
 * The location a route that names one project opens.
 *
 * The workspace a project belongs to arrives from the backend, but which project
 * the route points at is already known, so the board opens in the same pass
 * instead of painting the workspace home until that request returns.
 */
function routeProjectLocation(
  projectRef: RuntimeProjectSpaceRef | null,
  focusedItemId: string | null
): CollaborationPlatformLocation | null {
  if (!projectRef) return null
  return {
    platformView: 'spaces',
    collaborationDomain: projectRef.projectStore === 'local' ? 'local' : 'cloud',
    workspaceId: null,
    workspaceView: 'projects',
    projectId: String(projectRef.projectId),
    projectView: 'board',
    issueId: focusedItemId,
  }
}
const PROJECT_STATUS_REFRESH_DELAYS_MS = [0, 500, 1_500] as const

// eslint-disable-next-line react-refresh/only-export-components
export function projectRuntimeStatusSignature(
  runtimeTaskLifecycle: RuntimeTaskLifecycleStoreSnapshot | undefined,
  project: RuntimeProjectSpaceRef
): string {
  return [...(runtimeTaskLifecycle?.tasks.entries() ?? [])]
    .flatMap(([key, lifecycle]) => {
      if (!sameProjectSpace(projectSpaceForRuntimeTask(lifecycle.address), project)) return []
      const status = runtimeTaskTrackingExecutionStatus(lifecycle)
      return status ? [`${key}:${status}`] : []
    })
    .sort()
    .join('|')
}

// eslint-disable-next-line react-refresh/only-export-components
export function toWeworkIssueTaskBinding(binding: WorkspaceTaskBinding): LoopItemTaskBinding {
  const mapped = toSharedIssueDetailTaskBinding(binding)
  return {
    ...mapped,
    modelSelection: mapped.modelSelection as LoopItemTaskBinding['modelSelection'],
  }
}

export interface WeworkCollaborationPlatformProps {
  workspaceTabId?: string
  user: User
  devices?: DeviceInfo[]
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  services: WorkbenchServices
  startupActive?: boolean
  workspaceActive?: boolean
  activeProjectRef?: RuntimeProjectSpaceRef | null
  defaultProjectRequested?: boolean
  focusedItemId?: string | null
  focusedCommentId?: string | null
  focusedCommentRequestKey?: string | null
  onFocusedItemHandled?: () => void
  onActiveProjectChange?: (project: LocatedProjectSpace | null) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onArchiveRuntimeTasks?: (
    addresses: RuntimeTaskAddress[]
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onCancelRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  sendRuntimePaneMessage?: WorkbenchContextValue['sendRuntimePaneMessage']
  onOpenSettings?: (options?: DesktopSidebarAccountSettingsOptions) => void
  onLogout?: () => void
  renderLocalProjectImporter?: (input: {
    mode: 'folder' | 'existing'
    projects: ProjectWithTasks[]
    onClose: () => void
    onCreated: (
      runtimeProjectKey: string,
      projectName: string,
      workspaceRoots: string[]
    ) => Promise<void>
  }) => ReactNode
}

function normalizeWorkspaceRoot(root: string): string {
  const trimmed = root.trim()
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed)
  const normalized = isWindowsPath ? trimmed.replaceAll('\\', '/').toLowerCase() : trimmed
  if (normalized === '/' || /^[a-z]:\/$/i.test(normalized)) return normalized
  return normalized.replace(isWindowsPath ? /\/+$/ : /[\\/]+$/, '')
}

function projectWorkspaceRoots(project: CollaborationProject): string[] {
  const roots = project.metadata?.workspace_roots
  return Array.isArray(roots)
    ? roots
        .filter((root): root is string => typeof root === 'string')
        .map(normalizeWorkspaceRoot)
        .filter(Boolean)
    : []
}

/** Adapts a project to desktop services, separating public stand-in and experimental coordinator actions. */
export function WeworkSharedProject({
  draftAccountScope,
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
  onOpenGroupThread,
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
}: {
  draftAccountScope: string
  api: SharedWorkspaceApi
  projectCatalogApi?: SharedWorkspaceApi['projects']
  detailServices?: ProjectSpaceDetailServices
  devices?: DeviceInfo[]
  focusedCommentId?: string | null
  focusedCommentRequestKey?: string | null
  focusedItemId?: string | null
  localProjects: ProjectWithTasks[]
  locale: 'zh-CN' | 'en'
  location: CollaborationPlatformLocation
  onFocusedItemHandled?: () => void
  onOpenGroupThread: NonNullable<CollaborationHostAdapter['openGroupThread']>
  onOpenSettings?: (options?: DesktopSidebarAccountSettingsOptions) => void
  onOpenStandInSettings?(roleId: string, deviceId: string): void
  standInDeviceId?: string
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onCancelRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  sendRuntimePaneMessage?: WorkbenchContextValue['sendRuntimePaneMessage']
  project: CollaborationProject
  conversationRequestKey?: string
  onOpenProjectConversation?(): void
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  runtimeWork?: RuntimeWorkListResponse | null
  runtimePort?: IssueRuntimeBindingPort
  services: WorkbenchServices
  setLocation: Dispatch<SetStateAction<CollaborationPlatformLocation>>
  userId: string | number
  workspace: CollaborationProjectRendererWorkspaceContext
}) {
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
  const personalTaskState = useIssuePersonalTaskState()
  const { taskComposer, setTaskComposer, closeTaskConversation } = personalTaskState
  const latestProjectRef = useRef(project)
  const previousProjectPropRef = useRef(project)
  const [pinnedProgressIssueId, setPinnedProgressIssueId] = useState<string | null>(null)
  if (location.issueId && pinnedProgressIssueId !== null) setPinnedProgressIssueId(null)
  const [refreshProjectRequestKey, setRefreshProjectRequestKey] = useState(0)
  const [notice, setNotice] = useState<{
    message: string
    tone: 'success' | 'error'
  } | null>(null)
  const clearNotice = useCallback(() => setNotice(null), [])
  const notify = useCallback(
    (message: string, kind: 'success' | 'error' = 'success') => setNotice({ message, tone: kind }),
    []
  )
  const [, setTaskBindingRevision] = useState(0)
  const runtimeTaskLifecycleRef = useRef(runtimeTaskLifecycle)
  useEffect(() => {
    runtimeTaskLifecycleRef.current = runtimeTaskLifecycle
  }, [runtimeTaskLifecycle])
  useEffect(() => {
    const previousProject = previousProjectPropRef.current
    previousProjectPropRef.current = project
    // Navigation can recreate an older host snapshot after settings are saved.
    if (
      String(project.id) !== String(previousProject.id) ||
      project.project_store !== previousProject.project_store ||
      JSON.stringify(project.execution_environment) !==
        JSON.stringify(previousProject.execution_environment)
    ) {
      latestProjectRef.current = project
    }
  }, [project])
  const hasFullWorkspaceAccess = 'access_role' in workspace
  const workspaceAccessRef = useRef(hasFullWorkspaceAccess)
  useLayoutEffect(() => {
    workspaceAccessRef.current = hasFullWorkspaceAccess
  }, [hasFullWorkspaceAccess])
  const scopedApi = useMemo<SharedWorkspaceApi>(
    () => ({
      ...api,
      projects: {
        ...api.projects,
        list: async () => {
          if (workspaceAccessRef.current) return api.projects.list(workspace.id)
          const accessibleProjects = await api.projects.list()
          return accessibleProjects.filter(candidate => String(candidate.id) === String(project.id))
        },
        create: input =>
          api.projects.create({
            ...input,
            workspaceId: workspace.id,
          }),
      },
      issues: {
        ...api.issues,
        async getBoardSnapshot(projectId) {
          const snapshot = await api.issues.getBoardSnapshot(projectId)
          const currentProject = {
            projectStore: project.project_store,
            projectId: String(project.id),
          }
          const bindingsChanged = reconcileProjectSpaceTaskBindings(
            currentProject,
            snapshot.taskBindings.map(binding => ({
              deviceId: binding.deviceId,
              taskId: binding.taskId,
            }))
          )
          if (bindingsChanged) setTaskBindingRevision(value => value + 1)
          return snapshot
        },
      },
    }),
    [api, project.id, project.project_store, workspace.id]
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
      renderBoardToolbarAction: onOpenProjectConversation
        ? () => (
            <Tooltip label={t('workbench.project_space_chat.open')} side="bottom">
              <button
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
              </button>
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
              onPublished={() => setRefreshProjectRequestKey(value => value + 1)}
              onOpenIssue={issueId => {
                setTaskComposer(null)
                setLocation(current => ({ ...current, projectView: 'board', issueId }))
                if (focusedItemId) onFocusedItemHandled?.()
              }}
              onOpenGroupSettings={() => {
                setTaskComposer(null)
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
        issueId: location.issueId,
        view: location.projectView,
        rootView: 'home',
        projectSettingsSection: location.projectSettingsSection,
      },
      navigate: next => {
        setTaskComposer(current => (current?.issue.id === next.issueId ? current : null))
        setLocation(current => ({
          ...current,
          workspaceId: workspace.id,
          workspaceView: 'projects',
          projectId: next.projectId,
          projectView: next.view,
          projectSettingsSection:
            next.view === 'manage' ? (next.projectSettingsSection ?? null) : null,
          issueId: next.issueId,
        }))
        if (!next.issueId && focusedItemId) onFocusedItemHandled?.()
      },
      openGroupThread: onOpenGroupThread,
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
      onOpenGroupThread,
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
      setTaskComposer,
      workspace.id,
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
  const runtimeRunningByAddress = useMemo(
    () => runtimeTasksRunningByAddress(runtimeWork, runtimeTaskLifecycle),
    [runtimeTaskLifecycle, runtimeWork]
  )
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
    (issue: CollaborationIssue) =>
      prepareIssueRuntimeArchive(scopedApi, issue.id, runtimeRunningByAddress, onCancelRuntimeTask),
    [onCancelRuntimeTask, runtimeRunningByAddress, scopedApi]
  )
  const runtimeTaskStatusSignature = projectRuntimeStatusSignature(runtimeTaskLifecycle, {
    projectStore: project.project_store,
    projectId: String(project.id),
  })

  useEffect(() => {
    if (!runtimeTaskStatusSignature) return
    const timeouts = PROJECT_STATUS_REFRESH_DELAYS_MS.map(delay =>
      window.setTimeout(() => {
        setRefreshProjectRequestKey(value => value + 1)
      }, delay)
    )
    return () => {
      for (const timeout of timeouts) window.clearTimeout(timeout)
    }
  }, [runtimeTaskStatusSignature])

  useEffect(
    () =>
      subscribeProjectSpaceTaskBindingChanged(change => {
        if (
          !sameProjectSpace(change.project, {
            projectStore: project.project_store,
            projectId: String(project.id),
          })
        ) {
          return
        }
        setTaskBindingRevision(value => value + 1)
        setRefreshProjectRequestKey(value => value + 1)
      }),
    [project.id, project.project_store]
  )

  useEffect(
    () =>
      subscribeProjectSpaceTaskContextChanged(change => {
        if (
          !sameProjectSpace(change.project, {
            projectStore: project.project_store,
            projectId: String(project.id),
          })
        ) {
          return
        }
        setRefreshProjectRequestKey(value => value + 1)
      }),
    [project.id, project.project_store]
  )

  useEffect(() => {
    const subscribe = detailServices?.projectChatClient?.subscribeLoopItemChanges
    if (!subscribe) return
    let active = true
    let unsubscribe: (() => void) | undefined
    void subscribe(event => {
      if (!active || event.projectId !== String(project.id)) return
      setRefreshProjectRequestKey(value => value + 1)
    })
      .then(release => {
        if (!active) {
          release()
          return
        }
        unsubscribe = release
      })
      .catch(error => {
        if (!active) return
        console.warn('[Wework collaboration] issue-change subscription failed', error)
      })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [detailServices?.projectChatClient, project.id])

  const openPersonalTaskIssue = useCallback(
    (issueId: string) => projectHost.navigate({ ...projectHost.location, issueId }),
    [projectHost]
  )
  const {
    openNewTaskConversation,
    openBoundTaskConversation,
    answerIssueDispatch,
    conversationPanel,
  } = useIssuePersonalTaskConversation({
    state: personalTaskState,
    project,
    latestProjectRef,
    api: scopedApi,
    detailServices,
    userId,
    taskOwnerUserId,
    services,
    runtimePort,
    runtimeWork,
    localProjects,
    onOpenRuntimeTask,
    onOpenIssue: openPersonalTaskIssue,
    locationIssueId: projectHost.location.issueId,
    notify,
    clearNotice,
    onChanged: () => setRefreshProjectRequestKey(value => value + 1),
  })

  // Only the board that shows the Issue answers, which is the board a click on
  // the notification switched to, whichever tab it came from.
  useEffect(
    () =>
      subscribeIssueDispatch({
        shows: action =>
          action.itemId === focusedItemId && String(action.projectId) === String(project.id),
        answer: action => {
          void answerIssueDispatch(action).catch(cause => {
            notify(cause instanceof Error ? cause.message : String(cause), 'error')
          })
        },
      }),
    [answerIssueDispatch, focusedItemId, notify, project.id]
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
        <CollaborationApp
          participationUserId={
            project.project_store === 'local'
              ? (services.localParticipationIdentity?.viewerUserIds ?? taskOwnerUserId)
              : taskOwnerUserId
          }
          isIssueRunning={isIssueRunning}
          parentGroupingEnabled
          api={scopedApi}
          renderIssueCreate={form => (
            <ThreadCreateDialog
              key={`${project.project_store}:${project.id}`}
              form={form}
              externalForm={
                ['github', 'gitlab', 'dingtalk_aitable'].includes(form.project.task_provider)
                  ? form
                  : undefined
              }
              api={api}
              groups={
                project.project_store === 'local'
                  ? services.chatGroupApis?.local
                  : services.chatGroupApis?.cloud
              }
              store={project.project_store === 'local' ? 'local' : 'cloud'}
              locale={locale}
              accountScope={project.project_store === 'local' ? 'local' : draftAccountScope}
            />
          )}
          initialProject={project}
          onProjectChange={nextProject => {
            latestProjectRef.current = nextProject
          }}
          host={projectHost}
          locale={locale}
          showProjectBack={false}
          refreshProjectRequestKey={refreshProjectRequestKey}
          issueArchiveEnabled
          onPrepareIssueArchive={
            project.project_store === 'local' ? prepareIssueArchive : undefined
          }
          onCreateTask={
            runtimePort ? async (_taskProject, issue) => openNewTaskConversation(issue) : undefined
          }
          renderIssueDetail={({
            api: issueApi,
            issue,
            allIssues,
            assignments,
            taskBindings,
            onRead,
            onChange,
            onClose,
            onCreateTask,
            onDelete,
            onOpenRelatedIssue,
            onAddChild,
          }) => (
            <IssueConversationDrawers
              key={issue.id}
              label={createCollaborationTranslator(locale)('todo.issue_details')}
              conversation={taskComposer?.issue.id === issue.id ? conversationPanel : null}
              conversationKey={taskComposer?.conversationKey}
              onClose={() => {
                closeTaskConversation()
                onClose()
              }}
              onCloseConversation={closeTaskConversation}
            >
              {closeDrawers => (
                <TodoEditor
                  key={issue.id}
                  getRuntimeTranscript={services.runtimeWorkApi?.getRuntimeTranscript}
                  mode="edit"
                  focusedCommentId={focusedItemId === issue.id ? focusedCommentId : null}
                  focusedCommentRequestKey={
                    focusedItemId === issue.id ? focusedCommentRequestKey : null
                  }
                  sharedApi={issueApi}
                  api={services.deliveryApi}
                  presentation="workspace-panel"
                  workspacePanelFill
                  readFirst
                  showPanelControls
                  item={issue as unknown as CloudLoopItem}
                  project={editorProject}
                  allItems={allIssues as unknown as CloudLoopItem[]}
                  showChildren={false}
                  onOpenRelatedIssue={related =>
                    onOpenRelatedIssue(related as unknown as CollaborationIssue)
                  }
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
                  taskExecutionStates={issueTaskExecutionStates(
                    taskBindings,
                    runtimeExecutionStatusByAddress
                  )}
                  deviceNamesById={deviceNamesById}
                  selectedTaskId={
                    taskComposer?.issue.id === issue.id
                      ? (taskComposer.address?.taskId ?? null)
                      : null
                  }
                  aitableApi={
                    project.task_provider === 'dingtalk_aitable' ? services.aitableApi : undefined
                  }
                  onCreateTask={onCreateTask}
                  onDelete={onDelete}
                  deleteLabel={createCollaborationTranslator(locale)('todo.archive_issue')}
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
                  onEscape={
                    taskComposer?.issue.id === issue.id ? closeTaskConversation : closeDrawers
                  }
                  onUpdated={updated => onChange(updated as unknown as CollaborationIssue)}
                  onRead={updated => onRead(updated as unknown as CollaborationIssue)}
                  onClose={closeDrawers}
                />
              )}
            </IssueConversationDrawers>
          )}
          renderBoardIssueCard={context => (
            <WeworkBoardIssueCard
              context={context}
              projectStore={project.project_store}
              runtimeWork={runtimeWork}
              runningByAddress={runtimeRunningByAddress}
              resolveAddress={binding =>
                workspaceExecutionAddress(
                  binding,
                  runtimeWork,
                  context.issue.id,
                  project.project_store
                )
              }
              getRuntimeTranscript={services.runtimeWorkApi?.getRuntimeTranscript}
              onOpenRuntimeTask={
                runtimePort
                  ? address => {
                      void openBoundTaskConversation(context.issue, address)
                    }
                  : onOpenRuntimeTask
              }
              renderBadges={badges => (
                <IssueChangeRequestBadges
                  badges={badges}
                  monitor={issueChangeRequestMonitor}
                  compact
                  testId={`cloud-todo-card-badges-${context.issue.id}`}
                />
              )}
            />
          )}
        />
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

export function WeworkCollaborationPlatform(props: WeworkCollaborationPlatformProps) {
  const markdownServices = useCollaborationMarkdownServices()
  const { i18n } = useTranslation('common')
  const { t: collaborationText } = useTranslation('collaboration')
  const cloud = useOptionalCloudConnection()
  const draftAccountScope = workbenchOwnershipKey(cloud, props.user)
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  const workspaceTabs = useOptionalWorkspaceTabs()
  const ownedTab = workspaceTabs?.tabs.find(tab => tab.id === props.workspaceTabId)
  const [browserSearch, setSearch] = useState(() => window.location.search)
  const ownedQueryIndex = ownedTab?.contentRoute.indexOf('?') ?? -1
  const search = props.workspaceTabId
    ? ownedTab && ownedQueryIndex >= 0
      ? ownedTab.contentRoute.slice(ownedQueryIndex)
      : ''
    : browserSearch
  const navigationOwner = useRef({ scope: draftAccountScope, mounted: false })
  useLayoutEffect(() => {
    navigationOwner.current = { scope: draftAccountScope, mounted: true }
    return () => {
      navigationOwner.current.mounted = false
    }
  }, [draftAccountScope])
  const canNavigate = useCallback(
    () => navigationOwner.current.mounted && navigationOwner.current.scope === draftAccountScope,
    [draftAccountScope]
  )
  const [boardReturn, setBoardReturn] = useState<BoardReturnOrigin | null>(null)
  const currentBoardReturn = retainBoardReturnOrigin(boardReturn, draftAccountScope, search)
  if (boardReturn && !currentBoardReturn) setBoardReturn(null)
  const [retainedView, setRetainedView] = useState(props.activeProjectRef ? 'projects' : 'groups')
  const view =
    new URLSearchParams(search).get('collaborationView') ??
    (props.activeProjectRef ? 'projects' : retainedView)
  if (retainedView !== view) setRetainedView(view)
  const [connectOpen, setConnectOpen] = useState(false)
  const savedGroupSearch = useRef('?collaborationView=groups')
  const savedProjectSearch = useRef(
    new URLSearchParams(search).has('itemId') ? '?collaborationView=projects' : search
  )
  const rememberedAccountScope = useRef(draftAccountScope)
  useLayoutEffect(() => {
    if (rememberedAccountScope.current !== draftAccountScope) {
      rememberedAccountScope.current = draftAccountScope
      savedGroupSearch.current = '?collaborationView=groups'
      savedProjectSearch.current = '?collaborationView=projects'
    }
  }, [draftAccountScope])
  useEffect(() => {
    if (props.workspaceTabId) return
    const changed = () => setSearch(window.location.search)
    window.addEventListener('popstate', changed)
    return () => window.removeEventListener('popstate', changed)
  }, [props.workspaceTabId])
  const publishSearch = useCallback(
    (nextSearch: string, replace = false) => {
      if (!canNavigate()) return
      if (props.workspaceTabId) {
        if (ownedTab && workspaceTabs)
          workspaceTabs.updateTab(props.workspaceTabId, { contentRoute: `/todo${nextSearch}` })
        return
      }
      setSearch(nextSearch)
      if (replace) replaceTo(`/todo${nextSearch}`)
      else navigateTo(`/todo${nextSearch}`)
    },
    [props.workspaceTabId, ownedTab, workspaceTabs, canNavigate, setSearch]
  )
  const onNavigate = useCallback(
    (nextSearch: string, relatedThreadId?: string) => {
      if (!canNavigate()) return
      if (view === 'groups') savedGroupSearch.current = search
      else savedProjectSearch.current = search
      const next = new URLSearchParams(nextSearch)
      setBoardReturn(current =>
        nextBoardReturnOrigin(current, draftAccountScope, search, nextSearch, relatedThreadId)
      )
      if (next.size === 1 && next.has('collaborationView')) {
        const restored = new URLSearchParams(
          next.get('collaborationView') === 'groups'
            ? savedGroupSearch.current
            : savedProjectSearch.current
        )
        restored.set('collaborationView', next.get('collaborationView')!)
        nextSearch = `?${restored.toString()}`
      }
      publishSearch(nextSearch)
    },
    [search, view, publishSearch, canNavigate, draftAccountScope]
  )
  const openProjectThread: NonNullable<CollaborationHostAdapter['openGroupThread']> = (
    groupId,
    threadId,
    store
  ) => {
    if (!canNavigate()) return
    const origin = new URLSearchParams(search)
    origin.set('collaborationView', 'projects')
    origin.delete('itemId')
    origin.delete('commentId')
    origin.delete('focusRequest')
    const groupStore = store === 'local' ? 'local' : 'cloud'
    setBoardReturn({
      scope: draftAccountScope,
      store: groupStore,
      groupId,
      threadId,
      search: `?${origin.toString()}`,
    })
    const target = new URLSearchParams({
      collaborationView: 'groups',
      groupStore,
      groupId,
      threadId,
      groupTab: 'chat',
    })
    onNavigate(`?${target.toString()}`)
  }
  const local = useMemo(
    () =>
      createLocalWorkspaceApi(
        props.services.projectSpaceApis?.local,
        Number(props.user.id),
        props.user.user_name,
        props.user.email ?? null,
        props.services.projectSpaceDetailServices?.local,
        locale
      ),
    [
      props.services.projectSpaceApis?.local,
      props.services.projectSpaceDetailServices?.local,
      props.user.id,
      props.user.user_name,
      props.user.email,
      locale,
    ]
  )
  const sources = useMemo(() => {
    const sources: GroupSource[] = []
    if (local && props.services.chatGroupApis?.local)
      sources.push({
        store: 'local',
        groups: props.services.chatGroupApis.local,
        workspace: local,
        chat: props.services.localProjectChatClient,
      })
    if (
      cloud.isConnected &&
      props.services.sharedWorkspaceApi &&
      props.services.chatGroupApis?.cloud
    )
      sources.push({
        store: 'cloud',
        groups: props.services.chatGroupApis.cloud,
        workspace: props.services.sharedWorkspaceApi,
        chat: props.services.projectChatClient,
      })
    return sources
  }, [
    local,
    cloud.isConnected,
    props.services.chatGroupApis,
    props.services.sharedWorkspaceApi,
    props.services.localProjectChatClient,
    props.services.projectChatClient,
  ])
  const groupRuntimeRunning = useMemo(
    () => runtimeTasksRunningByAddress(props.runtimeWork, props.runtimeTaskLifecycle),
    [props.runtimeWork, props.runtimeTaskLifecycle]
  )
  const prepareThreadArchive = useCallback(
    async (context: ThreadArchivePreparationContext) => {
      if (context.sourceStore !== 'local') return
      await prepareIssueRuntimeArchive(
        context.api,
        context.item.id,
        groupRuntimeRunning,
        props.onCancelRuntimeTask
      )
    },
    [props.onCancelRuntimeTask, groupRuntimeRunning]
  )
  const threadRoute = new URLSearchParams(search)
  const personalTaskOwner = threadWorkOwner(
    draftAccountScope,
    threadRoute.get('groupStore') === 'cloud' ? 'cloud' : 'local',
    threadRoute.get('groupId'),
    threadRoute.get('threadId')
  )
  const groupDeviceNames = useMemo(
    () => Object.fromEntries((props.devices ?? []).map(device => [device.device_id, device.name])),
    [props.devices]
  )
  const legacyParams = new URLSearchParams(search)
  const legacyStore = legacyParams.get('projectStore') === 'local' ? 'local' : 'cloud'
  const resolveLegacyDestination = useCallback(
    (nextSearch: string) => publishSearch(nextSearch, true),
    [publishSearch]
  )
  const legacyDestination = useLegacyThreadDestination({
    api: sources.find(source => source.store === legacyStore)?.workspace,
    itemId: legacyParams.has('groupId') ? null : legacyParams.get('itemId'),
    store: legacyStore,
    commentId: legacyParams.get('commentId'),
    focusRequest: legacyParams.get('focusRequest'),
    onNavigate: resolveLegacyDestination,
  })
  const readySent = useRef(false)
  const onReady = useCallback(() => {
    if (
      !props.startupActive ||
      readySent.current ||
      !isElectronRuntime() ||
      getDesktopWindowLabel() !== 'main'
    )
      return
    readySent.current = true
    void invokeDesktopHost<void>('renderer.startupReady').catch(error =>
      console.error('[Wework] Failed to reveal collaboration', error)
    )
  }, [props.startupActive])
  useEffect(() => {
    if (legacyDestination.failed) onReady()
  }, [legacyDestination.failed, onReady])
  return (
    <MarkdownServicesProvider value={markdownServices}>
      {legacyDestination.pending || legacyDestination.failed ? (
        <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-text-muted">
          <p role={legacyDestination.failed ? 'alert' : 'status'}>
            {collaborationText(legacyDestination.failed ? 'threadLinkUnavailable' : 'loading')}
          </p>
          {legacyDestination.failed && (
            <div className="flex items-center gap-2">
              <Button data-testid="thread-link-retry" onClick={legacyDestination.retry}>
                {collaborationText('retry')}
              </Button>
              <Button
                variant="ghost"
                data-testid="thread-link-back"
                onClick={() => resolveLegacyDestination(savedGroupSearch.current)}
              >
                {collaborationText('backToGroups')}
              </Button>
              {legacyStore === 'cloud' && !cloud.isConnected && (
                <Button
                  variant="ghost"
                  data-testid="thread-link-connect"
                  onClick={() => setConnectOpen(true)}
                >
                  {collaborationText('connectCloud')}
                </Button>
              )}
            </div>
          )}
        </div>
      ) : view === 'groups' ? (
        <GroupThreadPersonalTaskController
          owner={personalTaskOwner}
          active={props.workspaceActive ?? true}
          locale={locale}
          services={props.services}
          localProjects={props.localProjects}
          runtimeWork={props.runtimeWork}
          runtimeTaskLifecycle={props.runtimeTaskLifecycle}
          onOpenRuntimeTask={props.onOpenRuntimeTask}
          deviceNamesById={groupDeviceNames}
        >
          <GroupThreadSurface
            onPrepareThreadArchive={prepareThreadArchive}
            accountScope={draftAccountScope}
            sources={sources}
            search={search}
            locale={locale}
            renderBoardIssueCard={(project, context) => (
              <WeworkBoardIssueCard
                context={context}
                projectStore={project.project_store}
                runtimeWork={props.runtimeWork}
                resolveAddress={binding =>
                  workspaceExecutionAddress(
                    binding,
                    props.runtimeWork,
                    context.issue.id,
                    project.project_store
                  )
                }
                getRuntimeTranscript={props.services.runtimeWorkApi?.getRuntimeTranscript}
                onOpenRuntimeTask={props.onOpenRuntimeTask}
              />
            )}
            onNavigate={onNavigate}
            onBackToBoard={
              currentBoardReturn ? () => onNavigate(currentBoardReturn.search) : undefined
            }
            onReady={onReady}
            onConnectCloud={cloud.isConnected ? undefined : () => setConnectOpen(true)}
            footer={
              props.onOpenSettings && props.onLogout ? (
                <DesktopSidebarAccount
                  user={props.user}
                  onOpenSettings={props.onOpenSettings}
                  onLogout={props.onLogout}
                />
              ) : null
            }
          />
        </GroupThreadPersonalTaskController>
      ) : null}
      <Activity
        key={draftAccountScope}
        mode={
          view !== 'groups' && !legacyDestination.pending && !legacyDestination.failed
            ? 'visible'
            : 'hidden'
        }
      >
        <div className="flex h-full min-h-0 min-w-0 flex-1">
          <WeworkCollaborationPlatformContent
            {...props}
            groupSources={sources}
            draftAccountScope={draftAccountScope}
            onGroupView={() => onNavigate('?collaborationView=groups')}
            onOpenGroupThread={openProjectThread}
          />
        </div>
      </Activity>
      {connectOpen && (
        <CloudConnectionDialog
          open
          onlineCloudDeviceCount={0}
          onClose={() => setConnectOpen(false)}
          onOpenSettings={() => {
            setConnectOpen(false)
            props.onOpenSettings?.({ settingsPage: 'connections' })
          }}
        />
      )}
    </MarkdownServicesProvider>
  )
}

/** Binds project navigation and stand-in indicators to the current account and project catalog. */
function WeworkCollaborationPlatformContent(
  props: WeworkCollaborationPlatformProps & {
    onGroupView(): void
    onOpenGroupThread: NonNullable<CollaborationHostAdapter['openGroupThread']>
    groupSources: GroupSource[]
    draftAccountScope: string
  }
) {
  const { i18n, t } = useTranslation('common')
  const standInProjects = useStandInProjects(props.services, props.devices, Number(props.user.id))
  const cloudConnection = useOptionalCloudConnection()
  const templateOwnerId =
    cloudConnection.user?.id && cloudConnection.user.id > 0
      ? cloudConnection.user.id
      : Number(props.user.id)
  const templateBackend = cloudConnection.apiBaseUrl ?? getRuntimeConfig().apiBaseUrl
  const templateScope = `${templateBackend}:${cloudConnection.user?.id ? 'account' : 'local'}:${templateOwnerId}`
  const templateStore = useMemo(
    () =>
      new CollaborationTemplateStore({
        scope: templateScope,
        ownerId: templateOwnerId,
        persistence: browserTemplatePersistence(templateScope, localStorage),
        remote: cloudConnection.isConnected
          ? createCollaborationTemplateRemote(
              createHttpClient({
                baseUrl: templateBackend,
                getToken: () => cloudConnection.token,
                redirectOnUnauthorized: false,
              })
            )
          : undefined,
      }),
    [
      templateBackend,
      templateOwnerId,
      templateScope,
      cloudConnection.isConnected,
      cloudConnection.token,
    ]
  )
  const [cloudLoginOpen, setCloudLoginOpen] = useState(false)
  const [conversationRequest, setConversationRequest] = useState<{
    projectId: string
    projectStore: CollaborationProject['project_store']
    accountScope: string
    key: string
  }>()
  const openProjectConversation = useCallback(
    (project: CollaborationProject) => {
      setConversationRequest({
        projectId: project.id,
        projectStore: project.project_store,
        accountScope: templateScope,
        key: crypto.randomUUID(),
      })
    },
    [templateScope]
  )
  const api = props.services.sharedWorkspaceApi
  const locale = useMemo(() => (i18n.language.startsWith('zh') ? 'zh-CN' : 'en'), [i18n.language])
  const collaborationUserName =
    props.user.user_name.trim().toLowerCase() === 'local'
      ? locale === 'zh-CN'
        ? '我'
        : 'Me'
      : props.user.user_name
  const personalOwnerLabel = locale === 'zh-CN' ? '个人' : 'Personal'
  const [ownerGroups, setOwnerGroups] = useState<Array<{ label: string; namespace: string }>>([])
  const workspaceOwnerOptions = useMemo(
    () => [{ label: personalOwnerLabel, namespace: 'default' }, ...ownerGroups],
    [ownerGroups, personalOwnerLabel]
  )
  const projectAgentConfiguration = useMemo(
    () =>
      createWeworkProjectAgentConfigurationHost(
        props.services.agentResourceApi,
        props.services.localProjectChatAgentApi,
        props.services.projectSpaceDetailServices?.local?.modelApi,
        props.services.pluginApi,
        props.services.deviceApi
      ),
    [
      props.services.agentResourceApi,
      props.services.deviceApi,
      props.services.projectSpaceDetailServices?.local?.modelApi,
      props.services.pluginApi,
      props.services.localProjectChatAgentApi,
    ]
  )
  useEffect(() => {
    let active = true
    const agentResourceApi = props.services.agentResourceApi
    if (!agentResourceApi?.listOwnerGroups) return
    void agentResourceApi
      .listOwnerGroups()
      .then(groups => {
        if (!active) return
        setOwnerGroups(
          groups.map(group => ({
            label: group.displayName,
            namespace: group.name,
          }))
        )
      })
      .catch(() => {
        if (active) setOwnerGroups([])
      })
    return () => {
      active = false
    }
  }, [props.services.agentResourceApi])
  const localProjectApi = useMemo(
    () =>
      createLocalWorkspaceApi(
        props.services.projectSpaceApis?.local,
        Number(props.user.id),
        collaborationUserName,
        props.user.email ?? null,
        props.services.projectSpaceDetailServices?.local,
        locale
      ),
    [
      props.services.projectSpaceApis?.local,
      props.services.projectSpaceDetailServices?.local,
      props.user.email,
      props.user.id,
      collaborationUserName,
      locale,
    ]
  )
  const platformApi = useMemo(() => {
    const platform = createWeworkPlatformApi(api, localProjectApi)
    if (!platform || !props.services.standInApi || !props.services.getLocalRuntimeSidebarIdentity)
      return platform
    const standIn = async (projectId: string) => {
      const project = await platform.projects.get(projectId)
      return bindProjectStandInApi(
        props.services.standInApi!,
        Number(props.user.id),
        project.project_store === 'local' ? 'local' : 'cloud',
        props.services.getLocalRuntimeSidebarIdentity!
      )
    }
    return {
      ...platform,
      standIn: {
        get: async (projectId: string, deviceId?: string, id?: string) =>
          (await standIn(projectId)).get(projectId, deviceId, id),
        save: async (
          projectId: string,
          settings: import('@wegent/collaboration').WorkspaceStandInSettings,
          deviceId?: string
        ) => (await standIn(projectId)).save(projectId, settings, deviceId),
        run: async (projectId: string, issueId: string, deviceId: string, id?: string) =>
          (await standIn(projectId)).run!(projectId, issueId, deviceId, id),
      },
    }
  }, [api, localProjectApi, props.services, props.user.id])
  const navigationApis = useMemo(
    () =>
      [
        localProjectApi,
        cloudConnection.isConnected && api?.workspaces
          ? withoutDefaultWorkItemProject(api)
          : undefined,
      ].filter((candidate): candidate is SharedWorkspaceApi => Boolean(candidate)),
    [api, cloudConnection.isConnected, localProjectApi]
  )
  const activeProject =
    String(props.activeProjectRef?.projectId) === DEFAULT_WORK_ITEM_PROJECT_ID
      ? null
      : (props.activeProjectRef ?? null)
  const routedProjectId = activeProject ? String(activeProject.projectId) : null
  const routedProjectStore = activeProject?.projectStore
  const [location, setLocation] = useState<CollaborationPlatformLocation>(() => ({
    ...(routeProjectLocation(activeProject, props.focusedItemId ?? null) ?? initialLocation),
  }))
  const [navigationSyncRevision, setNavigationSyncRevision] = useState(0)
  const startupReadySent = useRef(false)
  const pendingNavigationProjectIdRef = useRef<string | null | undefined>(undefined)
  const navigationRequestRevisionRef = useRef(0)
  const resolvedWorkspaceProjectRef = useRef<string | null>(null)
  const publishActiveProject = useStableEvent((project: LocatedProjectSpace | null) =>
    props.onActiveProjectChange?.(project)
  )
  // An external route supersedes an internal project's pending lookup, even
  // when it only selects another Issue or comment in the same project.
  // API refreshes in the same account do not revoke the user's navigation intent.
  useLayoutEffect(() => {
    navigationRequestRevisionRef.current += 1
    pendingNavigationProjectIdRef.current = undefined
    return () => {
      navigationRequestRevisionRef.current += 1
    }
  }, [
    activeProject?.projectId,
    activeProject?.projectStore,
    templateScope,
    props.focusedCommentId,
    props.focusedCommentRequestKey,
    props.focusedItemId,
  ])

  useEffect(() => {
    const activeProjectId = routedProjectId
    if (pendingNavigationProjectIdRef.current !== undefined) {
      if (pendingNavigationProjectIdRef.current !== activeProjectId) return
      pendingNavigationProjectIdRef.current = undefined
    }
    if (!platformApi?.projects.get || !activeProjectId || !routedProjectStore) return
    let cancelled = false
    const target = routeProjectLocation(
      { projectId: activeProjectId, projectStore: routedProjectStore },
      props.focusedItemId ?? null
    )
    if (target) {
      const routedFocus = props.focusedItemId ?? null
      // Apply a notification focus when its route changes, not again when the
      // reader selects another Issue before the old focus is cleared.
      queueMicrotask(() => {
        if (cancelled) return
        setLocation(current => {
          const movingProject = String(current.projectId ?? '') !== target.projectId
          if (!movingProject && routedFocus === null) return current
          const issueId = movingProject ? routedFocus : (routedFocus ?? current.issueId)
          if (
            !movingProject &&
            current.issueId === issueId &&
            current.workspaceView === target.workspaceView &&
            current.projectView === target.projectView
          )
            return current
          return {
            ...current,
            ...target,
            issueId,
            projectSettingsSection: null,
          }
        })
      })
    }

    // The workspace the board belongs to is the one thing the route cannot name,
    // so it is resolved once per project without holding the board back.
    if (resolvedWorkspaceProjectRef.current !== activeProjectId) {
      resolvedWorkspaceProjectRef.current = activeProjectId
      void platformApi.projects
        .get(activeProjectId)
        .then(project => {
          if (cancelled) return
          setLocation(current => {
            if (String(current.projectId ?? '') !== activeProjectId) return current
            const collaborationDomain = project.project_store === 'local' ? 'local' : 'cloud'
            const workspaceId = project.workspace_id ?? null
            if (
              current.collaborationDomain === collaborationDomain &&
              current.workspaceId === workspaceId
            )
              return current
            return { ...current, collaborationDomain, workspaceId }
          })
        })
        .catch(() => {
          // The board still opens from the route; only its workspace stays unknown.
        })
    }
    return () => {
      cancelled = true
    }
  }, [
    routedProjectId,
    routedProjectStore,
    navigationSyncRevision,
    platformApi,
    props.focusedCommentId,
    props.focusedCommentRequestKey,
    props.focusedItemId,
  ])

  const platformRouteReady =
    !activeProject || String(location.projectId) === String(activeProject.projectId)
  const handleReady = useCallback(() => {
    if (
      !props.startupActive ||
      !platformRouteReady ||
      startupReadySent.current ||
      !isElectronRuntime() ||
      getDesktopWindowLabel() !== 'main'
    ) {
      return
    }
    startupReadySent.current = true
    void invokeDesktopHost<void>('renderer.startupReady').catch(error => {
      console.error('[Wework] Failed to reveal the ready collaboration space', error)
    })
  }, [platformRouteReady, props.startupActive])
  if (!platformApi) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        协作服务当前不可用
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex-1" data-testid="wework-collaboration-platform">
      {cloudLoginOpen && (
        <CloudConnectionDialog
          open
          onlineCloudDeviceCount={0}
          onClose={() => setCloudLoginOpen(false)}
          onOpenSettings={() => {
            setCloudLoginOpen(false)
            props.onOpenSettings?.({ settingsPage: 'connections' })
          }}
        />
      )}
      <CollaborationPlatformApp
        sidebarHeader={
          <CollaborationViewSwitcher
            value="projects"
            onChange={view => view === 'groups' && props.onGroupView()}
          />
        }
        api={platformApi}
        refreshKey={String(Boolean(props.startupActive))}
        navigationApis={navigationApis}
        locale={locale}
        onReady={handleReady}
        host={{
          accountScope: templateScope,
          templateStore,
          templateNavigation: true,
          openProjectConversation,
          renderProjectSidebarBadge: project => {
            const enabled = standInProjects.has(
              `${project.project_store === 'local' ? 'local' : 'cloud'}:${project.id}`
            )
            if (!enabled) return null

            return (
              <span
                className="collaboration-project-sidebar-badge flex shrink-0 text-text-secondary"
                title={t('standIn.project_enabled')}
                aria-label={t('standIn.project_enabled')}
                data-testid={`stand-in-project-${project.id}`}
              >
                <StandInIcon enabled className="h-4 w-4" />
              </span>
            )
          },
          currentUser: {
            id: Number(props.user.id),
            name: collaborationUserName,
          },
          cloudAccess: {
            authenticated: cloudConnection.isConnected,
            requestLogin: () => setCloudLoginOpen(true),
          },
          renderThreadHome: ({ projects }) => (
            <ThreadCreationHome
              accountScope={props.draftAccountScope}
              sources={props.groupSources}
              projects={projects}
              locale={locale}
              onConnectCloud={() => setCloudLoginOpen(true)}
            />
          ),
          loadProjectCollaborationGroupGenerationModels: async () => {
            const response = await props.services.modelApi.listModels()
            const models = response.data.filter(
              model => model.isActive !== false && !model.compatibilityDisabled
            )
            const defaultSelection =
              getNewChatModelSelection(props.user) ?? defaultNewChatModelSelection(models)
            return {
              models: models.map(model => ({
                modelName: model.name,
                modelType: model.type,
                displayName: getModelDisplayLabel(model),
                options: {
                  ...getDefaultModelOptions(model),
                  ...modelSelectionIdentityOptions(model),
                },
              })),
              defaultSelection,
            }
          },
          generateProjectCollaborationGroupDraft: (input, onProgress, onEvent) =>
            generateCollaborationGroupDraft({
              input,
              textGenerationApi: props.services.textGenerationApi,
              onProgress,
              onEvent,
            }),
          location,
          capabilities: {
            automation: true,
            dingtalkAitable: true,
            projectLocation: location.workspaceId === LOCAL_WORKSPACE_ID ? 'local' : 'cloud',
            workspaceLocations: ['local', 'cloud'],
            sidebarPresentation: 'full',
          },
          navigate: nextLocation => {
            const navigationRevision = ++navigationRequestRevisionRef.current
            if (props.onActiveProjectChange) {
              pendingNavigationProjectIdRef.current = nextLocation.projectId
                ? String(nextLocation.projectId)
                : null
            }
            setLocation({
              ...nextLocation,
              projectSettingsSection:
                nextLocation.projectView === 'manage'
                  ? (nextLocation.projectSettingsSection ?? null)
                  : null,
            })
            if (!nextLocation.projectId) {
              publishActiveProject(null)
              return
            }
            const requestedProjectId = String(nextLocation.projectId)
            void platformApi.projects
              .get(requestedProjectId)
              .then(project => {
                if (navigationRequestRevisionRef.current !== navigationRevision) return
                publishActiveProject({
                  ...project,
                  location: project.project_store === 'local' ? 'local' : 'cloud',
                })
              })
              .catch(() => {
                if (navigationRequestRevisionRef.current !== navigationRevision) return
                pendingNavigationProjectIdRef.current = undefined
                setNavigationSyncRevision(value => value + 1)
              })
          },
          manageResource: (kind, resourceId, source) => {
            if (kind === 'environments') {
              props.onOpenSettings?.(resolveDeviceResourceSettingsOptions(resourceId, source))
              return
            }
            setLocation(current => ({
              ...current,
              collaborationDomain: source ?? current.collaborationDomain,
              rootView: current.workspaceId ? current.rootView : 'agents',
              workspaceView: current.workspaceId ? 'agents' : 'home',
              projectId: null,
              projectSettingsSection: null,
              issueId: null,
            }))
          },
          renderDeviceCreator: ({ source, workspaceId, hasCloudDevice, onClose, onCreated }) =>
            source === 'cloud' && workspaceId && api?.workspaces?.registerRunner ? (
              <WorkspaceRunnerRegistrationDialog
                workspaceId={workspaceId}
                register={api.workspaces.registerRunner}
                onClose={onClose}
                onDone={() => onCreated()}
              />
            ) : source === 'cloud' ? (
              <AddCloudDeviceDialog
                open
                cloudConnection={cloudConnection}
                hasCloudDevice={hasCloudDevice}
                onClose={onClose}
                onCreated={(_devices, createdDeviceId) => onCreated(createdDeviceId)}
              />
            ) : (
              <div
                className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4"
                data-testid="local-device-resource-dialog"
                role="presentation"
                onClick={event => {
                  if (event.target === event.currentTarget) onClose()
                }}
              >
                <section
                  aria-modal="true"
                  className="w-full max-w-lg rounded-lg border border-border bg-popover p-5 shadow-lg"
                  role="dialog"
                >
                  <h2 className="text-sm font-semibold text-text-primary">
                    {locale === 'zh-CN' ? '本地设备' : 'Local device'}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    {locale === 'zh-CN'
                      ? '当前设备已自动加入本地空间，无需重复创建。安装并启用本机执行环境后，智能体和协作小组即可在这台设备上运行。'
                      : 'This device is already part of the local space. Install and enable its execution environments to run Agents and teams locally.'}
                  </p>
                  <div className="mt-5 flex justify-end">
                    <button
                      className="inline-flex h-8 items-center rounded-md bg-text-primary px-4 text-sm text-background"
                      data-testid="local-device-resource-confirm"
                      onClick={onClose}
                      type="button"
                    >
                      {locale === 'zh-CN' ? '知道了' : 'Done'}
                    </button>
                  </div>
                </section>
              </div>
            ),
          renderProjectImporter: props.renderLocalProjectImporter
            ? ({ mode, projects: collaborationProjects, onClose, onImported }) => {
                const importedRuntimeProjectKeys = new Set(
                  collaborationProjects.flatMap(project => {
                    const key = project.metadata?.code_project_key
                    return typeof key === 'string' ? [key] : []
                  })
                )
                const importedWorkspaceRoots = new Set(
                  collaborationProjects.flatMap(projectWorkspaceRoots)
                )
                const runtimeProjectIdentitiesById = new Map(
                  (props.runtimeWork?.projects ?? []).map(projectWork => [
                    runtimeProjectUiId(projectWork.project),
                    {
                      key: projectWork.project.key,
                      roots: Array.from(
                        new Set([
                          ...(projectWork.project.roots ?? []).map(root => root.path),
                          ...projectWork.deviceWorkspaces
                            .filter(workspace => workspace.workspaceKind !== 'chat')
                            .map(workspace => workspace.workspacePath),
                        ])
                      )
                        .map(normalizeWorkspaceRoot)
                        .filter(Boolean),
                    },
                  ])
                )
                const availableProjects = props.localProjects.filter(project => {
                  const runtimeProject = runtimeProjectIdentitiesById.get(project.id)
                  if (runtimeProject && importedRuntimeProjectKeys.has(runtimeProject.key)) {
                    return false
                  }
                  const workspacePath =
                    project.config?.workspace?.source === 'local_path' &&
                    typeof project.config.workspace.localPath === 'string'
                      ? normalizeWorkspaceRoot(project.config.workspace.localPath)
                      : null
                  const workspaceRoots = new Set([
                    ...(runtimeProject?.roots ?? []),
                    ...(workspacePath ? [workspacePath] : []),
                  ])
                  return ![...workspaceRoots].some(root => importedWorkspaceRoots.has(root))
                })
                return props.renderLocalProjectImporter!({
                  mode,
                  projects: availableProjects,
                  onClose,
                  onCreated: async (runtimeProjectKey, projectName, workspaceRoots) => {
                    const localDeliveryApi = props.services.projectSpaceApis?.local
                    if (!localDeliveryApi?.importLocalCodeProject) {
                      throw new Error(
                        locale === 'zh-CN'
                          ? '本地协作服务当前不可用'
                          : 'The local collaboration service is unavailable'
                      )
                    }
                    const importedProject = await localDeliveryApi.importLocalCodeProject({
                      runtimeProjectKey,
                      name: projectName,
                      roots: workspaceRoots,
                    })
                    if (!localProjectApi) {
                      throw new Error(
                        locale === 'zh-CN'
                          ? '本地协作服务当前不可用'
                          : 'The local collaboration service is unavailable'
                      )
                    }
                    const currentProject = await localProjectApi.projects.get(
                      String(importedProject.id)
                    )
                    await onImported({
                      ...currentProject,
                      workspace_id: LOCAL_WORKSPACE_ID,
                    })
                  },
                })
              }
            : undefined,
          workspaceOwnerOptions,
          projectAgentConfiguration,
        }}
        sidebarFooter={
          props.onOpenSettings && props.onLogout ? (
            <DesktopSidebarAccount
              user={props.user}
              onOpenSettings={props.onOpenSettings}
              onLogout={props.onLogout}
            />
          ) : null
        }
        renderProject={({ project, workspace }) => {
          const projectApi = project.project_store === 'local' ? localProjectApi : api
          if (!projectApi) return null
          const runtimePort = issueRuntimeBindingPort(props.services, project.project_store)
          return (
            <WeworkSharedProject
              draftAccountScope={props.draftAccountScope}
              api={projectApi}
              projectCatalogApi={platformApi?.projects}
              detailServices={
                props.services.projectSpaceDetailServices?.[
                  project.project_store === 'local' ? 'local' : 'cloud'
                ]
              }
              devices={props.devices}
              focusedCommentId={props.focusedCommentId}
              focusedCommentRequestKey={props.focusedCommentRequestKey}
              focusedItemId={props.focusedItemId}
              localProjects={props.localProjects}
              locale={locale}
              location={location}
              onFocusedItemHandled={props.onFocusedItemHandled}
              onOpenSettings={props.onOpenSettings}
              onOpenStandInSettings={(roleId, deviceId) => {
                const query = new URLSearchParams({
                  profileId: roleId,
                  deviceId,
                  settingsRequest: crypto.randomUUID(),
                })
                navigateTo(`/stand-in?${query}`)
              }}
              onOpenRuntimeTask={props.onOpenRuntimeTask}
              onCancelRuntimeTask={props.onCancelRuntimeTask}
              sendRuntimePaneMessage={props.sendRuntimePaneMessage}
              project={project}
              onOpenProjectConversation={() => openProjectConversation(project)}
              conversationRequestKey={
                conversationRequest?.projectId === project.id &&
                conversationRequest.projectStore === project.project_store &&
                conversationRequest.accountScope === templateScope
                  ? conversationRequest.key
                  : undefined
              }
              runtimeTaskLifecycle={props.runtimeTaskLifecycle}
              runtimeWork={props.runtimeWork}
              runtimePort={runtimePort}
              services={props.services}
              setLocation={setLocation}
              onOpenGroupThread={props.onOpenGroupThread}
              userId={props.user.id}
              workspace={workspace}
            />
          )
        }}
      />
      <WeworkCollaborationEmbeddedBrowserHost workspaceActive={props.workspaceActive ?? true} />
    </div>
  )
}
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
