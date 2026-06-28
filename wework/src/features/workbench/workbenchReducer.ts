import type {
  DeviceWorkspaceResponse,
  DeviceInfo,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeProjectWork,
  RuntimeWorkListResponse,
  Team,
  User,
  UserPreferences,
} from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'

type WorkbenchDeviceStatus = DeviceInfo['status']

export const initialWorkbenchState: WorkbenchState = {
  user: null,
  defaultTeam: null,
  projects: [],
  devices: [],
  runtimeWork: null,
  currentProject: null,
  currentRuntimeTask: null,
  selectedDeviceWorkspaceId: null,
  pendingProjectWorkspaceProjectId: null,
  standaloneDeviceId: null,
  standaloneWorkspacePath: null,
  input: '',
  isBootstrapping: true,
  isSending: false,
  error: null,
}

export type WorkbenchAction =
  | {
      type: 'bootstrapped'
      user: User
      defaultTeam: Team | null
      projects: ProjectWithTasks[]
      devices: DeviceInfo[]
      runtimeWork?: RuntimeWorkListResponse | null
      currentProject?: ProjectWithTasks | null
      standaloneDeviceId?: string | null
      standaloneWorkspacePath?: string | null
    }
  | {
      type: 'lists_refreshed'
      projects: ProjectWithTasks[]
      devices: DeviceInfo[]
      runtimeWork?: RuntimeWorkListResponse | null
      standaloneDeviceId?: string | null
      standaloneWorkspacePath?: string | null
    }
  | {
      type: 'devices_refreshed'
      devices: DeviceInfo[]
      standaloneDeviceId?: string | null
      standaloneWorkspacePath?: string | null
    }
  | {
      type: 'runtime_work_refreshed'
      runtimeWork: RuntimeWorkListResponse
    }
  | {
      type: 'device_status_changed'
      deviceId: string
      status: WorkbenchDeviceStatus
      name?: string | null
    }
  | { type: 'bootstrap_failed'; error: string }
  | { type: 'project_created'; project: ProjectWithTasks }
  | { type: 'project_selected'; project: ProjectWithTasks }
  | { type: 'device_workspace_prepared'; mapping: DeviceWorkspaceResponse }
  | {
      type: 'project_workspace_selected'
      project: ProjectWithTasks
      deviceWorkspaceId: number | null
    }
  | { type: 'project_updated'; project: ProjectWithTasks }
  | {
      type: 'project_cleared'
      standaloneDeviceId?: string | null
      standaloneWorkspacePath?: string | null
    }
  | { type: 'user_preferences_updated'; preferences: UserPreferences }
  | { type: 'standalone_device_preference_changed'; standaloneDeviceId: string | null }
  | {
      type: 'runtime_task_opened'
      address: RuntimeTaskAddress
      project: ProjectWithTasks | null
    }
  | { type: 'current_task_cleared' }
  | { type: 'input_changed'; input: string }
  | { type: 'sending_started' }
  | { type: 'sending_finished' }
  | { type: 'error_set'; error: string | null }

function keepDevicesOnTransientEmpty(
  currentDevices: DeviceInfo[],
  nextDevices: DeviceInfo[]
): DeviceInfo[] {
  if (nextDevices.length > 0) return nextDevices
  if (currentDevices.length > 0) return currentDevices
  return nextDevices
}

function updateRuntimeWorkDeviceStatus(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  deviceId: string,
  status: WorkbenchDeviceStatus
): RuntimeWorkListResponse | null {
  if (!runtimeWork) return null

  const updateWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => {
    if (workspace.deviceId !== deviceId) return workspace
    return {
      ...workspace,
      deviceStatus: status,
      available: status !== 'offline',
    }
  }

  return {
    ...runtimeWork,
    projects: runtimeWork.projects.map(project => ({
      ...project,
      deviceWorkspaces: project.deviceWorkspaces.map(updateWorkspace),
    })),
    chats: runtimeWork.chats.map(updateWorkspace),
  }
}

function findRuntimeTaskAddressByLocalTaskId(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  localTaskId: string
): RuntimeTaskAddress | null {
  if (!runtimeWork) return null

  let match: RuntimeTaskAddress | null = null
  const workspaces = [
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
    ...runtimeWork.chats,
  ]

  for (const workspace of workspaces) {
    if (!workspace.localTasks.some(task => task.localTaskId === localTaskId)) continue

    const address = {
      deviceId: workspace.deviceId,
      localTaskId,
    }
    if (match && match.deviceId !== address.deviceId) {
      return null
    }
    match = address
  }

  return match
}

function reconcileCurrentRuntimeTaskAddress(
  currentRuntimeTask: RuntimeTaskAddress | null,
  devices: DeviceInfo[],
  runtimeWork: RuntimeWorkListResponse | null | undefined
): RuntimeTaskAddress | null {
  if (!currentRuntimeTask) return null
  if (devices.some(device => device.device_id === currentRuntimeTask.deviceId)) {
    return currentRuntimeTask
  }

  return (
    findRuntimeTaskAddressByLocalTaskId(runtimeWork, currentRuntimeTask.localTaskId) ??
    currentRuntimeTask
  )
}

function resolveCurrentProjectAfterRefresh(
  currentProject: ProjectWithTasks | null,
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null | undefined
): ProjectWithTasks | null {
  if (!currentProject) return null

  const backendProject = projects.find(project => project.id === currentProject.id)
  if (backendProject) return backendProject

  const runtimeProject = runtimeWork?.projects.find(
    projectWork => runtimeProjectUiId(projectWork.project) === currentProject.id
  )
  return runtimeProject ? runtimeProjectToProject(runtimeProject) : null
}

function runtimeWorkspaceFromMapping(
  mapping: DeviceWorkspaceResponse,
  devices: DeviceInfo[]
): RuntimeDeviceWorkspace {
  const device = devices.find(item => item.device_id === mapping.deviceId)
  return {
    id: mapping.id,
    projectId: mapping.projectId,
    deviceId: mapping.deviceId,
    deviceName: device?.name ?? mapping.deviceId,
    deviceStatus: device?.status ?? null,
    workspacePath: mapping.workspacePath,
    workspaceKind: mapping.label ?? 'workspace',
    label: mapping.label,
    repoUrl: mapping.repoUrl,
    repoRootFingerprint: mapping.repoRootFingerprint,
    mapped: true,
    available: device ? device.status !== 'offline' : true,
    localTasks: [],
  }
}

function upsertPreparedRuntimeWorkspace(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projects: ProjectWithTasks[],
  devices: DeviceInfo[],
  mapping: DeviceWorkspaceResponse
): RuntimeWorkListResponse {
  const project = projects.find(item => item.id === mapping.projectId)
  const projectRef = {
    key: `project:${mapping.projectId}`,
    id: mapping.projectId,
    name: project?.name ?? '',
    description: project?.description,
    color: project?.color,
  }
  const currentRuntimeWork = runtimeWork ?? {
    projects: [],
    chats: [],
    totalLocalTasks: 0,
  }
  const nextWorkspace = runtimeWorkspaceFromMapping(mapping, devices)
  const hasProject = currentRuntimeWork.projects.some(
    item => runtimeProjectUiId(item.project) === mapping.projectId
  )
  const projectsWithTarget = hasProject
    ? currentRuntimeWork.projects.map(item => {
        if (runtimeProjectUiId(item.project) !== mapping.projectId) return item
        const workspaces = item.deviceWorkspaces.filter(
          workspace =>
            !(
              workspace.deviceId === mapping.deviceId &&
              workspace.workspacePath === mapping.workspacePath
            )
        )
        return {
          ...item,
          project: {
            ...item.project,
            ...projectRef,
          },
          deviceWorkspaces: [...workspaces, nextWorkspace],
        }
      })
    : ([
        ...currentRuntimeWork.projects,
        {
          project: projectRef,
          deviceWorkspaces: [nextWorkspace],
        },
      ] as RuntimeProjectWork[])

  return {
    ...currentRuntimeWork,
    projects: projectsWithTarget,
    chats: currentRuntimeWork.chats.filter(
      workspace =>
        !(
          workspace.deviceId === mapping.deviceId &&
          workspace.workspacePath === mapping.workspacePath
        )
    ),
  }
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case 'bootstrapped': {
      const devices = keepDevicesOnTransientEmpty(state.devices, action.devices)
      const runtimeWork = action.runtimeWork === undefined ? state.runtimeWork : action.runtimeWork
      return {
        ...state,
        user: action.user,
        defaultTeam: action.defaultTeam,
        projects: action.projects,
        devices,
        runtimeWork,
        currentRuntimeTask: reconcileCurrentRuntimeTaskAddress(
          state.currentRuntimeTask,
          devices,
          runtimeWork
        ),
        currentProject:
          action.currentProject === undefined ? state.currentProject : action.currentProject,
        standaloneDeviceId:
          action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
        standaloneWorkspacePath:
          action.standaloneWorkspacePath === undefined
            ? state.standaloneWorkspacePath
            : action.standaloneWorkspacePath,
        isBootstrapping: false,
        error: null,
      }
    }
    case 'lists_refreshed': {
      const devices = keepDevicesOnTransientEmpty(state.devices, action.devices)
      const runtimeWork = action.runtimeWork === undefined ? state.runtimeWork : action.runtimeWork
      const refreshedState = {
        ...state,
        projects: action.projects,
        devices,
        runtimeWork,
        currentRuntimeTask: reconcileCurrentRuntimeTaskAddress(
          state.currentRuntimeTask,
          devices,
          runtimeWork
        ),
        currentProject: resolveCurrentProjectAfterRefresh(
          state.currentProject,
          action.projects,
          runtimeWork
        ),
        standaloneDeviceId:
          action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
        standaloneWorkspacePath:
          action.standaloneWorkspacePath === undefined
            ? state.standaloneWorkspacePath
            : action.standaloneWorkspacePath,
      }
      return refreshedState
    }
    case 'devices_refreshed': {
      const devices = keepDevicesOnTransientEmpty(state.devices, action.devices)
      return {
        ...state,
        devices,
        currentRuntimeTask: reconcileCurrentRuntimeTaskAddress(
          state.currentRuntimeTask,
          devices,
          state.runtimeWork
        ),
        standaloneDeviceId:
          action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
        standaloneWorkspacePath:
          action.standaloneWorkspacePath === undefined
            ? state.standaloneWorkspacePath
            : action.standaloneWorkspacePath,
      }
    }
    case 'runtime_work_refreshed':
      return {
        ...state,
        runtimeWork: action.runtimeWork,
        currentProject: resolveCurrentProjectAfterRefresh(
          state.currentProject,
          state.projects,
          action.runtimeWork
        ),
        currentRuntimeTask: reconcileCurrentRuntimeTaskAddress(
          state.currentRuntimeTask,
          state.devices,
          action.runtimeWork
        ),
      }
    case 'device_status_changed':
      return {
        ...state,
        devices: state.devices.map(device => {
          if (device.device_id !== action.deviceId) return device
          return {
            ...device,
            name: action.name || device.name,
            status: action.status,
          }
        }),
        runtimeWork: updateRuntimeWorkDeviceStatus(
          state.runtimeWork,
          action.deviceId,
          action.status
        ),
      }
    case 'bootstrap_failed':
      return { ...state, isBootstrapping: false, error: action.error }
    case 'project_created':
      return {
        ...state,
        projects: [
          action.project,
          ...state.projects.filter(project => project.id !== action.project.id),
        ],
      }
    case 'project_selected':
      return {
        ...state,
        currentProject: action.project,
        selectedDeviceWorkspaceId: null,
        pendingProjectWorkspaceProjectId: null,
        standaloneWorkspacePath: null,
        currentRuntimeTask: null,
      }
    case 'device_workspace_prepared':
      return {
        ...state,
        selectedDeviceWorkspaceId: action.mapping.id,
        pendingProjectWorkspaceProjectId: null,
        runtimeWork: upsertPreparedRuntimeWorkspace(
          state.runtimeWork,
          state.projects,
          state.devices,
          action.mapping
        ),
      }
    case 'project_workspace_selected':
      return {
        ...state,
        currentProject: action.project,
        selectedDeviceWorkspaceId: action.deviceWorkspaceId,
        pendingProjectWorkspaceProjectId:
          action.deviceWorkspaceId === null ? action.project.id : null,
        standaloneWorkspacePath: null,
        currentRuntimeTask: null,
      }
    case 'project_updated':
      return {
        ...state,
        currentProject:
          state.currentProject?.id === action.project.id ? action.project : state.currentProject,
        projects: state.projects.map(project =>
          project.id === action.project.id ? action.project : project
        ),
      }
    case 'project_cleared':
      return {
        ...state,
        currentProject: null,
        selectedDeviceWorkspaceId: null,
        pendingProjectWorkspaceProjectId: null,
        standaloneDeviceId:
          action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
        standaloneWorkspacePath:
          action.standaloneWorkspacePath === undefined
            ? state.standaloneWorkspacePath
            : action.standaloneWorkspacePath,
        currentRuntimeTask: null,
      }
    case 'user_preferences_updated':
      return {
        ...state,
        user: state.user
          ? {
              ...state.user,
              preferences: action.preferences,
            }
          : state.user,
      }
    case 'standalone_device_preference_changed':
      return {
        ...state,
        standaloneDeviceId: action.standaloneDeviceId,
        standaloneWorkspacePath: null,
      }
    case 'runtime_task_opened':
      return {
        ...state,
        currentProject: action.project,
        currentRuntimeTask: action.address,
      }
    case 'current_task_cleared':
      return { ...state, currentRuntimeTask: null }
    case 'input_changed':
      return { ...state, input: action.input }
    case 'sending_started':
      return { ...state, isSending: true, error: null }
    case 'sending_finished':
      return { ...state, isSending: false }
    case 'error_set':
      return { ...state, error: action.error }
  }
}
