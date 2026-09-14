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
  collaborationTestIds,
  toSharedIssueDetailTaskBinding,
  type CollaborationMember,
  type CollaborationHostAdapter,
  type CollaborationIssue,
  type CollaborationPlatformLocation,
  type CollaborationProjectRendererWorkspaceContext,
  type CollaborationProject,
  type CollaborationWorkspace,
  type SharedWorkspaceApi,
  type WorkspaceTaskBinding,
} from '@wegent/collaboration'
import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'
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
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import {
  isRuntimeTaskExecutionRunning,
  runtimeTaskTrackingExecutionStatus,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import { AiChatModal } from './AiChatModal'
import { CloudTodoBoardCard, type CloudTodoBoardTaskBinding } from './CloudTodoBoardCard'
import { projectBoundRuntimeTaskStatuses } from './runtimeMyWork'
import { TodoEditor } from './TodoEditor'
import {
  projectSpaceForRuntimeTask,
  publishProjectSpaceTaskBindingChanged,
  reconcileProjectSpaceTaskBindings,
  sameProjectSpace,
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
  type LocatedProjectSpace,
} from './projectSpaceSelection'
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

interface IssueRuntimeBindingPort {
  bindTask(
    issueId: string,
    task: RuntimeTaskAddress,
    taskTitle?: string | null,
    workflowNodeId?: string | null
  ): Promise<void>
  unbindTask(issueId: string, task: RuntimeTaskAddress): Promise<void>
}

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

// Shared host adapters are imported by the legacy workspace while this module
// incrementally converges on the shared collaboration platform.
// eslint-disable-next-line react-refresh/only-export-components
export function createLocalWorkspaceApi(
  deliveryApi: ProjectSpaceApis['local'] | undefined,
  userId: number,
  userName: string,
  userEmail: string | null,
  detailServices?: ProjectSpaceDetailServices,
  locale: 'zh-CN' | 'en' = 'zh-CN'
): SharedWorkspaceApi | null {
  if (!deliveryApi) return null
  const delivery = createWeworkDeliverySharedWorkspaceApi(deliveryApi)
  const automation = createWeworkAutomationSharedWorkspaceApi(
    deliveryApi,
    detailServices?.projectAutomationApi,
    detailServices?.projectIncomingHookApi
  )
  const decorateProject = (project: CollaborationProject): CollaborationProject => ({
    ...project,
    workspace_id: LOCAL_WORKSPACE_ID,
    current_user_id: userId,
    current_user_name: userName,
  })
  const projects = async () => (await delivery.projects.list()).map(decorateProject)
  const executionEnvironments = async () => {
    const devices = await detailServices?.deviceApi.listDevices()
    const now = new Date().toISOString()
    return (devices ?? [])
      .filter(device => device.device_type === 'local' || device.device_type === 'app')
      .map(device => ({
        id: `device:${device.device_id}`,
        device_id: device.id,
        device_key: device.device_id,
        name: device.name,
        kind: 'local_device' as const,
        coding_tools: device.capabilities ?? [],
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
      location: 'local',
      name: locale === 'zh-CN' ? '本地空间' : 'Local space',
      description:
        locale === 'zh-CN'
          ? '保存在当前设备上的项目、Issue 与执行资源。'
          : 'Projects, issues, and execution resources stored on this device.',
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
    throw new Error(
      locale === 'zh-CN'
        ? '本地空间不支持此操作'
        : 'This operation is not available in the local space'
    )
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
    ...(automation.automations
      ? {
          automations: {
            ...automation.automations,
            runWorkflowNode: unavailable,
            cancelRun: unavailable,
            retryRun: unavailable,
          },
        }
      : {}),
    ...(automation.incomingHooks
      ? {
          incomingHooks: {
            ...automation.incomingHooks,
            listEvents: unavailable,
          },
        }
      : {}),
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
          list: async projectId =>
            (await projectAgentApi.list(projectId)).map(agent => ({ ...agent })),
          create: async (projectId, input) => ({
            ...(await projectAgentApi.create(
              projectId,
              input as Parameters<typeof projectAgentApi.create>[1]
            )),
          }),
          update: async (projectId, agentId, input) => ({
            ...(await projectAgentApi.update(
              projectId,
              agentId,
              input as Parameters<typeof projectAgentApi.update>[2]
            )),
          }),
        }
      : {
          list: async () => [],
          create: unavailable,
          update: unavailable,
        },
    projects: {
      ...delivery.projects,
      list: projects,
      get: async projectId => decorateProject(await delivery.projects.get(projectId)),
      listExecutionEnvironments: executionEnvironments,
      addExecutionEnvironment: unavailable,
      removeExecutionEnvironment: unavailable,
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

// eslint-disable-next-line react-refresh/only-export-components
export function createWeworkPlatformApi(
  cloudApi: SharedWorkspaceApi | undefined,
  localDeliveryApi: ProjectSpaceApis['local'] | undefined,
  userId: number,
  userName: string,
  userEmail: string | null,
  localDetailServices?: ProjectSpaceDetailServices,
  locale: 'zh-CN' | 'en' = 'zh-CN'
): SharedWorkspaceApi | null {
  const localApi = createLocalWorkspaceApi(
    localDeliveryApi,
    userId,
    userName,
    userEmail,
    localDetailServices,
    locale
  )
  if (!localApi) return cloudApi ?? null
  if (!cloudApi?.workspaces) return localApi

  const isLocalWorkspace = (workspaceId: string | undefined) => workspaceId === LOCAL_WORKSPACE_ID
  const localProject = async (projectId: string) => {
    try {
      return await localApi.projects.get(projectId)
    } catch {
      return undefined
    }
  }
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
      async list(workspaceId) {
        if (isLocalWorkspace(workspaceId)) {
          return localApi.projects.list(LOCAL_WORKSPACE_ID)
        }
        if (workspaceId) {
          return cloudApi.projects.list(workspaceId)
        }
        const localProjects = await localApi.projects.list(LOCAL_WORKSPACE_ID)
        try {
          return [...localProjects, ...(await cloudApi.projects.list())]
        } catch {
          return localProjects
        }
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
      async listExecutionEnvironments(projectId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.listExecutionEnvironments(projectId)
          : cloudApi.projects.listExecutionEnvironments(projectId)
      },
      async addExecutionEnvironment(projectId, deviceId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.addExecutionEnvironment(projectId, deviceId)
          : cloudApi.projects.addExecutionEnvironment(projectId, deviceId)
      },
      async removeExecutionEnvironment(projectId, deviceId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.removeExecutionEnvironment(projectId, deviceId)
          : cloudApi.projects.removeExecutionEnvironment(projectId, deviceId)
      },
      async importMessages(projectId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.importMessages(projectId, input)
          : cloudApi.projects.importMessages(projectId, input)
      },
    },
    members: {
      ...cloudApi.members,
      list(projectId) {
        return projectLocation(projectId).then(location =>
          location === 'local' ? localApi.members.list(projectId) : cloudApi.members.list(projectId)
        )
      },
      searchUsers(query) {
        return cloudApi.members.searchUsers(query)
      },
      async add(projectId, memberUserId, role) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.members.add(projectId, memberUserId, role)
          : cloudApi.members.add(projectId, memberUserId, role)
      },
      async update(projectId, memberUserId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.members.update(projectId, memberUserId, input)
          : cloudApi.members.update(projectId, memberUserId, input)
      },
      async remove(projectId, memberUserId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.members.remove(projectId, memberUserId)
          : cloudApi.members.remove(projectId, memberUserId)
      },
    },
    agents: {
      ...cloudApi.agents,
      async list(projectId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.agents.list(projectId)
          : cloudApi.agents.list(projectId)
      },
      async create(projectId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.agents.create(projectId, input)
          : cloudApi.agents.create(projectId, input)
      },
      async update(projectId, agentId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.agents.update(projectId, agentId, input)
          : cloudApi.agents.update(projectId, agentId, input)
      },
    },
    issues: {
      ...cloudApi.issues,
      async getBoardSnapshot(projectId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.issues.getBoardSnapshot(projectId)
          : cloudApi.issues.getBoardSnapshot(projectId)
      },
    },
    resources: {
      async list() {
        const localResources = localApi.resources
          ? await localApi.resources.list()
          : { agents: [], execution_environments: [] }
        if (!cloudApi.resources) return localResources
        try {
          const cloudResources = await cloudApi.resources.list()
          return {
            agents: [...localResources.agents, ...cloudResources.agents],
            execution_environments: [
              ...localResources.execution_environments,
              ...cloudResources.execution_environments,
            ],
          }
        } catch {
          return localResources
        }
      },
    },
  }
}

export function WeworkSharedProject({
  api,
  detailServices,
  focusedItemId,
  localProjects,
  locale,
  location,
  onFocusedItemHandled,
  onOpenRuntimeTask,
  project,
  runtimeTaskLifecycle,
  runtimeWork,
  runtimePort,
  services,
  setLocation,
  userId,
  workspace,
}: {
  api: SharedWorkspaceApi
  detailServices?: ProjectSpaceDetailServices
  focusedItemId?: string | null
  localProjects: ProjectWithTasks[]
  locale: 'zh-CN' | 'en'
  location: CollaborationPlatformLocation
  onFocusedItemHandled?: () => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  project: CollaborationProject
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  runtimeWork?: RuntimeWorkListResponse | null
  runtimePort?: IssueRuntimeBindingPort
  services: WorkbenchServices
  setLocation: Dispatch<SetStateAction<CollaborationPlatformLocation>>
  userId: string | number
  workspace: CollaborationProjectRendererWorkspaceContext
}) {
  const [taskComposer, setTaskComposer] = useState<{
    address?: RuntimeTaskAddress
    issue: CollaborationIssue
    workflowStep?: string
  } | null>(null)
  const [pinnedProgressIssueId, setPinnedProgressIssueId] = useState<string | null>(null)
  const [refreshProjectRequestKey, setRefreshProjectRequestKey] = useState(0)
  const [, setTaskBindingRevision] = useState(0)
  const runtimeTaskLifecycleRef = useRef(runtimeTaskLifecycle)
  useEffect(() => {
    runtimeTaskLifecycleRef.current = runtimeTaskLifecycle
  }, [runtimeTaskLifecycle])
  const hasFullWorkspaceAccess = 'access_role' in workspace
  const scopedApi = useMemo<SharedWorkspaceApi>(
    () => ({
      ...api,
      projects: {
        ...api.projects,
        list: async () => {
          if (hasFullWorkspaceAccess) return api.projects.list(workspace.id)
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
          if (project.project_store !== 'local') return snapshot
          return {
            ...snapshot,
            items: projectBoundRuntimeTaskStatuses(
              snapshot.items as unknown as CloudLoopItem[],
              snapshot.taskBindings.map(binding => ({
                loop_item_id: binding.issueId,
                device_id: binding.deviceId,
                task_id: binding.taskId,
              })),
              runtimeTaskLifecycleRef.current
            ) as unknown as CollaborationIssue[],
          }
        },
      },
    }),
    [api, hasFullWorkspaceAccess, project.id, project.project_store, workspace.id]
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
  const editorProject = useMemo(
    () =>
      ({
        ...project,
        location: project.project_store === 'local' ? 'local' : 'cloud',
      }) as unknown as CloudProject,
    [project]
  )
  const runtimeRunningByAddress = useMemo(() => {
    const running = new Map<string, boolean>()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(item => item.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const runtimeWorkspace of workspaces) {
      for (const task of runtimeWorkspace.tasks) {
        running.set(
          runtimeConversationKey({
            deviceId: runtimeWorkspace.deviceId,
            taskId: task.taskId,
          }),
          isRuntimeTaskExecutionRunning(task)
        )
      }
    }
    for (const lifecycle of runtimeTaskLifecycle?.tasks.values() ?? []) {
      running.set(
        runtimeConversationKey(lifecycle.address),
        lifecycle.execution.running || lifecycle.turn.active
      )
    }
    return running
  }, [runtimeTaskLifecycle, runtimeWork])
  const runtimeTaskStatusSignature =
    project.project_store === 'local'
      ? ''
      : projectRuntimeStatusSignature(runtimeTaskLifecycle, {
          projectStore: project.project_store,
          projectId: String(project.id),
        })
  const localRuntimeLifecycleVersion =
    project.project_store === 'local' ? runtimeTaskLifecycle?.version : undefined
  const previousLocalRuntimeRef = useRef({
    projectId: project.project_store === 'local' ? String(project.id) : null,
    version: localRuntimeLifecycleVersion,
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

  useEffect(() => {
    const projectId = project.project_store === 'local' ? String(project.id) : null
    const previous = previousLocalRuntimeRef.current
    previousLocalRuntimeRef.current = {
      projectId,
      version: localRuntimeLifecycleVersion,
    }
    if (
      projectId === null ||
      localRuntimeLifecycleVersion === undefined ||
      previous.projectId !== projectId ||
      previous.version === localRuntimeLifecycleVersion
    ) {
      return
    }
    const timeouts = PROJECT_STATUS_REFRESH_DELAYS_MS.map(delay =>
      window.setTimeout(() => {
        setRefreshProjectRequestKey(value => value + 1)
      }, delay)
    )
    return () => {
      for (const timeout of timeouts) window.clearTimeout(timeout)
    }
  }, [localRuntimeLifecycleVersion, project.id, project.project_store])

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

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div className="min-w-0 flex-1">
        <CollaborationApp
          api={scopedApi}
          host={projectHost}
          locale={locale}
          automationUiHost={weworkAutomationUiHost}
          showProjectBack={false}
          refreshProjectRequestKey={refreshProjectRequestKey}
          onCreateTask={
            runtimePort
              ? (_taskProject, issue, workflowStep) => {
                  setTaskComposer({ issue, workflowStep })
                }
              : undefined
          }
          renderIssueDetail={({
            api: issueApi,
            issue,
            allIssues,
            assignments,
            taskBindings,
            onChange,
            onClose,
            onCreateTask,
          }) => (
            <div
              className="collaboration-dialog-backdrop collaboration-issue-detail-backdrop"
              data-testid={collaborationTestIds.issueDetail}
              onMouseDown={event => {
                if (event.currentTarget === event.target) onClose()
              }}
            >
              <div className="collaboration-issue-detail-shared-host collaboration-issue-detail-github-host">
                <TodoEditor
                  key={issue.id}
                  mode="edit"
                  sharedApi={issueApi}
                  presentation="workspace-panel"
                  workspacePanelFill
                  readFirst
                  showPanelControls
                  showFullscreenControl={false}
                  item={issue as unknown as CloudLoopItem}
                  project={editorProject}
                  allItems={allIssues as unknown as CloudLoopItem[]}
                  projectChatAgentApi={detailServices?.projectChatAgentApi}
                  projectAutomationApi={
                    project.project_store === 'local'
                      ? detailServices?.projectAutomationApi
                      : undefined
                  }
                  teamApi={services.teamApi}
                  projectChatClient={detailServices?.projectChatClient}
                  selfManagedExecution={project.project_store === 'local'}
                  currentUserId={userId}
                  currentAssignment={
                    assignments
                      .filter(assignment => assignment.status === 'active')
                      .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
                      .at(-1) ?? null
                  }
                  localProjects={localProjects}
                  initialTaskBindings={taskBindings.map(toWeworkIssueTaskBinding)}
                  aitableApi={
                    project.task_provider === 'dingtalk_aitable' ? services.aitableApi : undefined
                  }
                  onCreateTask={onCreateTask}
                  onOpenTaskConversation={
                    runtimePort
                      ? task =>
                          setTaskComposer({
                            issue,
                            address: {
                              deviceId: task.device_id,
                              taskId: task.task_id,
                            },
                          })
                      : onOpenRuntimeTask
                        ? task =>
                            onOpenRuntimeTask({
                              deviceId: task.device_id,
                              taskId: task.task_id,
                            })
                        : undefined
                  }
                  onUpdated={updated => onChange(updated as unknown as CollaborationIssue)}
                  onClose={() => {
                    setTaskComposer(null)
                    onClose()
                  }}
                />
              </div>
            </div>
          )}
          renderBoardIssueCard={({
            display,
            focused,
            issue,
            nativeContainerProps,
            onOpen,
            taskBindings,
          }) => {
            const boardTaskBindings = taskBindings.map(
              binding =>
                ({
                  id: binding.id,
                  device_id: binding.deviceId,
                  task_id: binding.taskId,
                  task_title: binding.taskTitle,
                  workflow_node_id: binding.workflowNodeId,
                  running:
                    runtimeRunningByAddress.get(
                      runtimeConversationKey({
                        deviceId: binding.deviceId,
                        taskId: binding.taskId,
                      })
                    ) ?? false,
                  modelSelection: binding.modelSelection,
                }) as CloudTodoBoardTaskBinding
            )
            return (
              <div
                {...nativeContainerProps}
                className="w-full"
                data-testid={collaborationTestIds.issue(issue.id)}
              >
                <CloudTodoBoardCard
                  item={
                    {
                      ...issue,
                      project_store: project.project_store,
                    } as unknown as CloudLoopItem
                  }
                  taskBindings={boardTaskBindings}
                  onClick={onOpen}
                  onArchive={() => undefined}
                  previewPinned={pinnedProgressIssueId === issue.id}
                  onPreviewPinnedChange={pinned =>
                    setPinnedProgressIssueId(pinned ? issue.id : null)
                  }
                  onOpenRuntimeTask={
                    runtimePort ? address => setTaskComposer({ issue, address }) : onOpenRuntimeTask
                  }
                  display={display}
                  processingStatus={issue.status === 'in_progress' || issue.status === 'in_review'}
                  dragDisabled
                  archiveDisabled
                  progressDisplay={focused ? 'focused' : 'compact'}
                />
              </div>
            )
          }}
        />
      </div>
      {taskComposer && runtimePort ? (
        <AiChatModal
          project={project as unknown as CloudProject}
          localProjects={localProjects}
          task={taskComposer.issue as unknown as CloudLoopItem}
          open
          embedded
          initialTaskInput={taskComposer.issue.description || taskComposer.issue.title}
          initialAddress={taskComposer.address}
          workflowNodeId={taskComposer.workflowStep}
          onClose={() => setTaskComposer(null)}
          onAddressChange={address => {
            setTaskComposer(current => (current ? { ...current, address } : current))
          }}
          onOpenRuntimeTask={onOpenRuntimeTask}
          prepareTask={async address => {
            await runtimePort.bindTask(
              taskComposer.issue.id,
              address,
              taskComposer.issue.title,
              taskComposer.workflowStep
            )
            const projectRef = {
              projectStore: project.project_store,
              projectId: String(project.id),
            }
            publishProjectSpaceTaskBindingChanged({
              task: address,
              project: projectRef,
              type: 'bound',
            })
            return async () => {
              await runtimePort.unbindTask(taskComposer.issue.id, address)
              publishProjectSpaceTaskBindingChanged({
                task: address,
                project: projectRef,
                type: 'unbound',
              })
            }
          }}
          onTaskCreated={async address => {
            setTaskComposer(current => (current ? { ...current, address } : current))
            const latest = await api.issues.get(taskComposer.issue.id)
            if (latest.status === 'inbox') {
              await api.issues.update(latest.id, {
                version: latest.version,
                status: 'pending',
              })
            }
            setRefreshProjectRequestKey(value => value + 1)
          }}
        />
      ) : null}
    </div>
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
  const platformApi = useMemo(
    () =>
      createWeworkPlatformApi(
        api,
        props.services.projectSpaceApis?.local,
        Number(props.user.id),
        collaborationUserName,
        props.user.email ?? null,
        props.services.projectSpaceDetailServices?.local,
        locale
      ),
    [
      api,
      props.services.projectSpaceApis?.local,
      props.services.projectSpaceDetailServices?.local,
      props.user.email,
      props.user.id,
      collaborationUserName,
      locale,
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
            workspaceLocations: api?.workspaces ? ['local', 'cloud'] : ['local'],
            sidebarPresentation: 'full',
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
          const localDeliveryApi = props.services.projectSpaceApis?.local
          const runtimePort =
            project.project_store === 'local' && localDeliveryApi
              ? {
                  bindTask: localDeliveryApi.bindTask,
                  unbindTask: localDeliveryApi.unbindTask,
                }
              : props.services.workspaceRuntimePort
          return (
            <WeworkSharedProject
              api={projectApi}
              detailServices={
                props.services.projectSpaceDetailServices?.[
                  project.project_store === 'local' ? 'local' : 'cloud'
                ]
              }
              focusedItemId={props.focusedItemId}
              localProjects={props.localProjects}
              locale={locale}
              location={location}
              onFocusedItemHandled={props.onFocusedItemHandled}
              onOpenRuntimeTask={props.onOpenRuntimeTask}
              project={project}
              runtimeTaskLifecycle={props.runtimeTaskLifecycle}
              runtimeWork={props.runtimeWork}
              runtimePort={runtimePort}
              services={props.services}
              setLocation={setLocation}
              userId={props.user.id}
              workspace={workspace}
            />
          )
        }}
      />
    </div>
  )
}
