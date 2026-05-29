import type { DeviceInfo, ProjectWithTasks, Task, Team, User } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'

export const initialWorkbenchState: WorkbenchState = {
  user: null,
  defaultTeam: null,
  projects: [],
  devices: [],
  recentTasks: [],
  currentProject: null,
  currentTask: null,
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
      recentTasks: Task[]
    }
  | {
      type: 'lists_refreshed'
      projects: ProjectWithTasks[]
      devices: DeviceInfo[]
      recentTasks: Task[]
    }
  | { type: 'bootstrap_failed'; error: string }
  | { type: 'project_selected'; project: ProjectWithTasks }
  | { type: 'task_opened'; task: Task; project?: ProjectWithTasks | null }
  | { type: 'input_changed'; input: string }
  | { type: 'sending_started' }
  | { type: 'sending_finished' }
  | { type: 'error_set'; error: string | null }

export function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction
): WorkbenchState {
  switch (action.type) {
    case 'bootstrapped':
      return {
        ...state,
        user: action.user,
        defaultTeam: action.defaultTeam,
        projects: action.projects,
        devices: action.devices,
        recentTasks: action.recentTasks,
        isBootstrapping: false,
        error: null,
      }
    case 'lists_refreshed':
      return {
        ...state,
        projects: action.projects,
        devices: action.devices,
        recentTasks: action.recentTasks,
        currentProject: state.currentProject
          ? action.projects.find(project => project.id === state.currentProject?.id) ?? null
          : null,
      }
    case 'bootstrap_failed':
      return { ...state, isBootstrapping: false, error: action.error }
    case 'project_selected':
      return { ...state, currentProject: action.project, currentTask: null }
    case 'task_opened':
      return {
        ...state,
        currentProject:
          action.project === undefined ? state.currentProject : action.project,
        currentTask: action.task,
      }
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
