import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  CollaborationApp,
  CollaborationPlatformApp,
  type CollaborationMember,
  type CollaborationHostAdapter,
  type CollaborationPlatformLocation,
  type CollaborationProject,
  type CollaborationWorkspace,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import {
  DesktopSidebarAccount,
  type DesktopSidebarAccountSettingsOptions,
} from '@/components/layout/DesktopSidebarAccount'
import {
  createWeworkAutomationSharedWorkspaceApi,
  createWeworkDeliverySharedWorkspaceApi,
} from '@/features/collaboration'
import type { ArchiveRuntimeConversationsResult } from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import type {
  ProjectSpaceDetailServices,
  ProjectSpaceApis,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import type {
  ProjectWithTasks,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import type { LocatedProjectSpace } from './projectSpaceSelection'
import { weworkAutomationUiHost } from './weworkAutomationUiHost'

const initialLocation: CollaborationPlatformLocation = {
  platformView: 'spaces',
  workspaceId: null,
  workspaceView: 'home',
  projectId: null,
  projectView: 'board',
  issueId: null,
}
const LOCAL_WORKSPACE_ID = 'wework-local-workspace'

export interface WeworkCollaborationPlatformProps {
  user: User
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  services: WorkbenchServices
  startupActive?: boolean
  activeProjectRef?: RuntimeProjectSpaceRef | null
  defaultProjectRequested?: boolean
  focusedItemId?: string | null
  onFocusedItemHandled?: () => void
  onActiveProjectChange?: (project: LocatedProjectSpace | null) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onArchiveRuntimeTasks?: (
    addresses: RuntimeTaskAddress[]
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onOpenSettings?: (options?: DesktopSidebarAccountSettingsOptions) => void
  onLogout?: () => void
}

function localWorkspaceApi(
  deliveryApi: NonNullable<ProjectSpaceApis['local']>,
  userId: number,
  userName: string,
  userEmail: string | null,
  detailServices?: ProjectSpaceDetailServices
): SharedWorkspaceApi | null {
  if (!deliveryApi) return null
  const delivery = createWeworkDeliverySharedWorkspaceApi(deliveryApi)
  const automation = createWeworkAutomationSharedWorkspaceApi(
    deliveryApi,
    detailServices?.projectAutomationApi,
    detailServices?.projectIncomingHookApi
  )
  const projects = async () =>
    (await delivery.projects.list())
      .filter(project => project.project_key !== 'WORK')
      .map(project => ({
        ...project,
        workspace_id: LOCAL_WORKSPACE_ID,
        current_user_id: userId,
        current_user_name: userName,
      }))
  const executionEnvironments = async () => {
    const devices = await detailServices?.deviceApi.listDevices()
    const now = new Date().toISOString()
    return (devices ?? [])
      .filter(device => device.device_type === 'local' || device.device_type === 'app')
      .map(device => ({
        id: `device:${device.device_id}`,
        device_key: device.device_id,
        name: device.name,
        kind: 'local_device' as const,
        owner_type: 'user' as const,
        owner_id: String(userId),
        owner_name: userName,
        status:
          device.status === 'online' || device.status === 'busy'
            ? ('online' as const)
            : ('offline' as const),
        updated_at: now,
      }))
  }
  const workspace = async (): Promise<CollaborationWorkspace> => {
    const [items, environments] = await Promise.all([projects(), executionEnvironments()])
    const now = new Date().toISOString()
    return {
      id: LOCAL_WORKSPACE_ID,
      name: '本地空间',
      description: '保存在当前设备上的项目、Issue 与执行资源。',
      access_role: 'Owner',
      member_count: 1,
      agent_count: 0,
      execution_environment_count: environments.length,
      project_count: items.length,
      created_by_user_id: userId,
      version: 1,
      created_at: now,
      updated_at: now,
    }
  }
  const unavailable = async (): Promise<never> => {
    throw new Error('本地空间不支持此操作')
  }
  const currentMember = async (): Promise<CollaborationMember[]> => [
    {
      id: userId,
      user_id: userId,
      user_name: userName,
      email: userEmail,
      role: 'Owner',
    },
  ]
  const projectAgentApi = detailServices?.projectChatAgentApi
  const projectChatClient = detailServices?.projectChatClient
  const issueProjectId = async (issueId: string) =>
    String((await delivery.issues.get(issueId)).cloud_project_id)

  return {
    ...(delivery as unknown as SharedWorkspaceApi),
    ...(automation.automations ? { automations: automation.automations } : {}),
    ...(automation.incomingHooks ? { incomingHooks: automation.incomingHooks } : {}),
    workspaces: {
      list: async () => [await workspace()],
      get: workspace,
      create: unavailable,
      update: unavailable,
      archive: unavailable,
      listMembers: currentMember,
      addMember: unavailable,
      updateMember: unavailable,
      removeMember: unavailable,
      listAgents: async () => [],
      addAgent: unavailable,
      removeAgent: unavailable,
      listExecutionEnvironments: executionEnvironments,
      addExecutionEnvironment: unavailable,
      removeExecutionEnvironment: unavailable,
    },
    resources: {
      list: async () => ({
        agents: [],
        execution_environments: await executionEnvironments(),
      }),
    },
    comments: projectChatClient
      ? {
          async list(issueId) {
            const { snapshot, unsubscribe } = await projectChatClient.subscribe(
              await issueProjectId(issueId),
              issueId,
              0,
              () => undefined
            )
            unsubscribe()
            return snapshot.messages.map(message => ({
              id: message.messageId,
              body: message.content,
              author: message.sender.name,
              web_url: null,
              created_at: message.createdAt,
              updated_at: message.updatedAt,
            }))
          },
          async create(issueId, body) {
            const message = await projectChatClient.send({
              projectId: await issueProjectId(issueId),
              taskId: issueId,
              clientMessageId: crypto.randomUUID(),
              text: body,
            })
            return {
              id: message.messageId,
              body: message.content,
              author: message.sender.name,
              web_url: null,
              created_at: message.createdAt,
              updated_at: message.updatedAt,
            }
          },
        }
      : {
          list: async () => [],
          create: unavailable,
        },
    agents: projectAgentApi
      ? {
          list: projectId => projectAgentApi.list(projectId),
          create: (projectId, input) =>
            projectAgentApi.create(
              projectId,
              input as Parameters<typeof projectAgentApi.create>[1]
            ),
          update: (projectId, agentId, input) =>
            projectAgentApi.update(
              projectId,
              agentId,
              input as Parameters<typeof projectAgentApi.update>[2]
            ),
        }
      : {
          list: async () => [],
          create: unavailable,
          update: unavailable,
        },
    projects: {
      ...delivery.projects,
      list: projects,
      get: async projectId => {
        const project = (await projects()).find(candidate => String(candidate.id) === projectId)
        if (!project) throw new Error(`Project ${projectId} was not found`)
        return project
      },
      importMessages: unavailable,
    },
    issues: {
      ...delivery.issues,
      async getBoardSnapshot(projectId) {
        const snapshot = await delivery.issues.getBoardSnapshot(projectId)
        return {
          ...snapshot,
          members: await currentMember(),
        }
      },
    },
    members: {
      ...delivery.members,
      list: currentMember,
    },
  }
}

function weworkPlatformApi(
  cloudApi: SharedWorkspaceApi | undefined,
  localDeliveryApi: NonNullable<ProjectSpaceApis['local']>,
  userId: number,
  userName: string,
  userEmail: string | null,
  localDetailServices?: ProjectSpaceDetailServices
): SharedWorkspaceApi | null {
  const localApi = localWorkspaceApi(
    localDeliveryApi,
    userId,
    userName,
    userEmail,
    localDetailServices
  )
  if (!localApi) return cloudApi ?? null
  if (!cloudApi?.workspaces) return localApi

  const isLocalWorkspace = (workspaceId: string | undefined) => workspaceId === LOCAL_WORKSPACE_ID
  const localProject = async (projectId: string) =>
    (await localApi.projects.list(LOCAL_WORKSPACE_ID)).find(
      candidate => String(candidate.id) === String(projectId)
    )
  const projectLocation = async (projectId: string) =>
    (await localProject(projectId)) ? 'local' : 'cloud'

  return {
    ...cloudApi,
    workspaces: {
      ...cloudApi.workspaces,
      async list() {
        const localWorkspace = await localApi.workspaces!.get(LOCAL_WORKSPACE_ID)
        try {
          return [localWorkspace, ...(await cloudApi.workspaces!.list())]
        } catch {
          return [localWorkspace]
        }
      },
      get(workspaceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.get(workspaceId)
          : cloudApi.workspaces!.get(workspaceId)
      },
      create: cloudApi.workspaces.create,
      update(workspaceId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.update(workspaceId, input)
          : cloudApi.workspaces!.update(workspaceId, input)
      },
      archive(workspaceId, version) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.archive(workspaceId, version)
          : cloudApi.workspaces!.archive(workspaceId, version)
      },
      listMembers(workspaceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.listMembers(workspaceId)
          : cloudApi.workspaces!.listMembers(workspaceId)
      },
      addMember(workspaceId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.addMember(workspaceId, input)
          : cloudApi.workspaces!.addMember(workspaceId, input)
      },
      updateMember(workspaceId, memberUserId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.updateMember(workspaceId, memberUserId, input)
          : cloudApi.workspaces!.updateMember(workspaceId, memberUserId, input)
      },
      removeMember(workspaceId, memberUserId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.removeMember(workspaceId, memberUserId)
          : cloudApi.workspaces!.removeMember(workspaceId, memberUserId)
      },
      listAgents(workspaceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.listAgents(workspaceId)
          : cloudApi.workspaces!.listAgents(workspaceId)
      },
      addAgent(workspaceId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.addAgent(workspaceId, input)
          : cloudApi.workspaces!.addAgent(workspaceId, input)
      },
      removeAgent(workspaceId, teamId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.removeAgent(workspaceId, teamId)
          : cloudApi.workspaces!.removeAgent(workspaceId, teamId)
      },
      listExecutionEnvironments(workspaceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.listExecutionEnvironments(workspaceId)
          : cloudApi.workspaces!.listExecutionEnvironments(workspaceId)
      },
      addExecutionEnvironment(workspaceId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.addExecutionEnvironment(workspaceId, input)
          : cloudApi.workspaces!.addExecutionEnvironment(workspaceId, input)
      },
      removeExecutionEnvironment(workspaceId, deviceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.removeExecutionEnvironment(workspaceId, deviceId)
          : cloudApi.workspaces!.removeExecutionEnvironment(workspaceId, deviceId)
      },
    },
    projects: {
      ...cloudApi.projects,
      list(workspaceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.projects.list(LOCAL_WORKSPACE_ID)
          : cloudApi.projects.list(workspaceId)
      },
      async create(input) {
        if (isLocalWorkspace(input.workspaceId)) {
          const project = await localApi.projects.create({
            ...input,
            workspaceId: undefined,
          })
          return { ...project, workspace_id: LOCAL_WORKSPACE_ID }
        }
        return cloudApi.projects.create(input)
      },
      async get(projectId) {
        return (await localProject(projectId)) ?? cloudApi.projects.get(projectId)
      },
      async update(projectId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.update(projectId, input)
          : cloudApi.projects.update(projectId, input)
      },
      async archive(projectId, version) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.archive(projectId, version)
          : cloudApi.projects.archive(projectId, version)
      },
      async importMessages(projectId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.importMessages(projectId, input)
          : cloudApi.projects.importMessages(projectId, input)
      },
    },
  }
}

function WeworkSharedProject({
  api,
  focusedItemId,
  locale,
  location,
  onFocusedItemHandled,
  project,
  setLocation,
  workspace,
}: {
  api: SharedWorkspaceApi
  focusedItemId?: string | null
  locale: 'zh-CN' | 'en'
  location: CollaborationPlatformLocation
  onFocusedItemHandled?: () => void
  project: CollaborationProject
  setLocation: Dispatch<SetStateAction<CollaborationPlatformLocation>>
  workspace: CollaborationWorkspace
}) {
  const scopedApi = useMemo<SharedWorkspaceApi>(
    () => ({
      ...api,
      projects: {
        ...api.projects,
        list: () => api.projects.list(workspace.id),
        create: input =>
          api.projects.create({
            ...input,
            workspaceId: workspace.id,
          }),
      },
    }),
    [api, workspace.id]
  )
  const projectHost = useMemo<CollaborationHostAdapter>(
    () => ({
      capabilities: {
        automation: true,
        dingtalkAitable: true,
      },
      location: {
        projectId: String(project.id),
        issueId: location.issueId,
        view: location.projectView,
        rootView: 'home',
      },
      navigate: next => {
        setLocation(current => ({
          ...current,
          workspaceId: workspace.id,
          workspaceView: 'projects',
          projectId: next.projectId,
          projectView: next.view,
          issueId: next.issueId,
        }))
        if (!next.issueId && focusedItemId) onFocusedItemHandled?.()
      },
    }),
    [
      focusedItemId,
      location.issueId,
      location.projectView,
      onFocusedItemHandled,
      project.id,
      setLocation,
      workspace.id,
    ]
  )

  return (
    <CollaborationApp
      api={scopedApi}
      host={projectHost}
      locale={locale}
      automationUiHost={weworkAutomationUiHost}
      showProjectBack={false}
    />
  )
}

export function WeworkCollaborationPlatform(props: WeworkCollaborationPlatformProps) {
  const { i18n } = useTranslation('common')
  const api = props.services.sharedWorkspaceApi
  const locale = useMemo(() => (i18n.language.startsWith('zh') ? 'zh-CN' : 'en'), [i18n.language])
  const collaborationUserName =
    props.user.user_name.trim().toLowerCase() === 'local'
      ? locale === 'zh-CN'
        ? '本地用户'
        : 'Local user'
      : props.user.user_name
  const localProjectApi = useMemo(
    () =>
      localWorkspaceApi(
        props.services.projectSpaceApis?.local,
        Number(props.user.id),
        collaborationUserName,
        props.user.email ?? null,
        props.services.projectSpaceDetailServices?.local
      ),
    [
      props.services.projectSpaceApis?.local,
      props.services.projectSpaceDetailServices?.local,
      props.user.email,
      props.user.id,
      collaborationUserName,
    ]
  )
  const platformApi = useMemo(
    () =>
      weworkPlatformApi(
        api,
        props.services.projectSpaceApis?.local,
        Number(props.user.id),
        collaborationUserName,
        props.user.email ?? null,
        props.services.projectSpaceDetailServices?.local
      ),
    [
      api,
      props.services.projectSpaceApis?.local,
      props.services.projectSpaceDetailServices?.local,
      props.user.email,
      props.user.id,
      collaborationUserName,
    ]
  )
  const activeProject = props.activeProjectRef ?? null
  const [location, setLocation] = useState<CollaborationPlatformLocation>(initialLocation)
  const startupReadySent = useRef(false)

  useEffect(() => {
    if (!platformApi?.projects.get || !activeProject) return
    if (String(location.projectId) === String(activeProject.projectId)) return

    let cancelled = false
    void platformApi.projects.get(String(activeProject.projectId)).then(project => {
      if (cancelled || !project.workspace_id) return
      setLocation(current => ({
        ...current,
        workspaceId: project.workspace_id ?? null,
        workspaceView: 'projects',
        projectId: String(project.id),
        projectView: 'board',
        issueId: props.focusedItemId ?? null,
      }))
    })
    return () => {
      cancelled = true
    }
  }, [activeProject, location.projectId, platformApi, props.focusedItemId])

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
      <CollaborationPlatformApp
        api={platformApi}
        locale={locale}
        onReady={handleReady}
        host={{
          location,
          capabilities: {
            automation: true,
            dingtalkAitable: true,
            projectLocation: location.workspaceId === LOCAL_WORKSPACE_ID ? 'local' : 'cloud',
          },
          navigate: nextLocation => {
            setLocation(nextLocation)
            if (!nextLocation.projectId) {
              props.onActiveProjectChange?.(null)
              return
            }
            void platformApi.projects.get(nextLocation.projectId).then(project =>
              props.onActiveProjectChange?.({
                ...project,
                location: project.project_store === 'local' ? 'local' : 'cloud',
              })
            )
          },
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
          return (
            <WeworkSharedProject
              api={projectApi}
              focusedItemId={props.focusedItemId}
              locale={locale}
              location={location}
              onFocusedItemHandled={props.onFocusedItemHandled}
              project={project}
              setLocation={setLocation}
              workspace={workspace}
            />
          )
        }}
      />
    </div>
  )
}
