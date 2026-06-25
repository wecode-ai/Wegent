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
import { runtimeProjectUiId } from '@/lib/runtime-project'

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
    case 'bootstrapped':
      return {
        ...state,
        user: action.user,
        defaultTeam: action.defaultTeam,
        projects: action.projects,
        devices: keepDevicesOnTransientEmpty(state.devices, action.devices),
        runtimeWork: action.runtimeWork === undefined ? state.runtimeWork : action.runtimeWork,
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
    case 'lists_refreshed': {
      const refreshedState = {
        ...state,
        projects: action.projects,
        devices: keepDevicesOnTransientEmpty(state.devices, action.devices),
        runtimeWork: action.runtimeWork === undefined ? state.runtimeWork : action.runtimeWork,
        currentProject: state.currentProject
          ? (action.projects.find(project => project.id === state.currentProject?.id) ?? null)
          : null,
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
    case 'devices_refreshed':
      return {
        ...state,
        devices: keepDevicesOnTransientEmpty(state.devices, action.devices),
        standaloneDeviceId:
          action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
        standaloneWorkspacePath:
          action.standaloneWorkspacePath === undefined
            ? state.standaloneWorkspacePath
            : action.standaloneWorkspacePath,
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
