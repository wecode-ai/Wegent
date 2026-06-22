import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  Team,
  User,
  UserPreferences,
} from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'

export const initialWorkbenchState: WorkbenchState = {
  user: null,
  defaultTeam: null,
  projects: [],
  devices: [],
  runtimeWork: null,
  currentProject: null,
  currentRuntimeTask: null,
  standaloneDeviceId: null,
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
    }
  | {
      type: 'lists_refreshed'
      projects: ProjectWithTasks[]
      devices: DeviceInfo[]
      runtimeWork?: RuntimeWorkListResponse | null
      standaloneDeviceId?: string | null
    }
  | {
      type: 'devices_refreshed'
      devices: DeviceInfo[]
      standaloneDeviceId?: string | null
    }
  | { type: 'bootstrap_failed'; error: string }
  | { type: 'project_selected'; project: ProjectWithTasks }
  | { type: 'project_updated'; project: ProjectWithTasks }
  | { type: 'project_cleared'; standaloneDeviceId?: string | null }
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
      }
    case 'bootstrap_failed':
      return { ...state, isBootstrapping: false, error: action.error }
    case 'project_selected':
      return {
        ...state,
        currentProject: action.project,
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
        standaloneDeviceId:
          action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
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
