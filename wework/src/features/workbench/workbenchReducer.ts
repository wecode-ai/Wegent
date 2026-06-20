import type {
  DeviceInfo,
  ModelSelectionConfig,
  ProjectTask,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  Task,
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
      type: 'task_opened'
      task: Task
      project?: ProjectWithTasks | null
      standaloneDeviceId?: string | null
    }
  | {
      type: 'runtime_task_opened'
      address: RuntimeTaskAddress
      project?: ProjectWithTasks | null
    }
  | { type: 'task_upserted'; task: Task }
  | { type: 'task_status_changed'; taskId: number; status: string }
  | {
      type: 'current_task_model_selection_changed'
      selection: ModelSelectionConfig
    }
  | { type: 'current_task_cleared' }
  | { type: 'input_changed'; input: string }
  | { type: 'sending_started' }
  | { type: 'sending_finished' }
  | { type: 'error_set'; error: string | null }

function taskBelongsToProject(task: Task): boolean {
  return Boolean(task.project_id && task.project_id > 0)
}

function removeTaskFromProjects(projects: ProjectWithTasks[], taskId: number): ProjectWithTasks[] {
  return projects.map(project => {
    if (!project.tasks?.some(task => task.task_id === taskId)) return project
    return {
      ...project,
      tasks: project.tasks.filter(task => task.task_id !== taskId),
    }
  })
}

function keepDevicesOnTransientEmpty(
  currentDevices: DeviceInfo[],
  nextDevices: DeviceInfo[]
): DeviceInfo[] {
  if (nextDevices.length > 0) return nextDevices
  if (currentDevices.length > 0) return currentDevices
  return nextDevices
}

function toProjectTask(task: Task): ProjectTask {
  return {
    id: task.id,
    task_id: task.id,
    task_title: task.title,
    task_status: task.status,
    title: task.title,
    status: task.status,
    source: task.source,
    task_type: task.task_type,
    created_at: task.created_at,
    updated_at: task.updated_at,
  }
}

function upsertTask<T>(
  tasks: T[] | undefined,
  taskId: number,
  nextTask: T,
  getTaskId: (task: T) => number
): T[] {
  const currentTasks = tasks ?? []
  const existingIndex = currentTasks.findIndex(task => getTaskId(task) === taskId)
  if (existingIndex === -1) return [nextTask, ...currentTasks]

  return currentTasks.map((task, index) => (index === existingIndex ? nextTask : task))
}

function upsertOpenedTask(state: WorkbenchState, task: Task): WorkbenchState {
  if (taskBelongsToProject(task)) {
    return {
      ...state,
      projects: state.projects.map(project =>
        project.id === task.project_id
          ? {
              ...project,
              tasks: upsertTask(project.tasks, task.id, toProjectTask(task), item => item.task_id),
            }
          : project
      ),
    }
  }

  return {
    ...state,
    projects: removeTaskFromProjects(state.projects, task.id),
  }
}

function normalizeOpenedTaskProject(
  task: Task,
  project: ProjectWithTasks | null | undefined
): Task {
  if (project === undefined) return task
  return {
    ...task,
    project_id: project?.id ?? 0,
  }
}

function workListsIncludeTask(projects: ProjectWithTasks[], task: Task): boolean {
  if (taskBelongsToProject(task)) {
    return projects.some(
      project =>
        project.id === task.project_id &&
        (project.tasks ?? []).some(projectTask => projectTask.task_id === task.id)
    )
  }

  return false
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
      if (state.currentTask && !workListsIncludeTask(action.projects, state.currentTask)) {
        return upsertOpenedTask(refreshedState, state.currentTask)
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
        currentTask: null,
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
        currentTask: null,
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
    case 'task_opened': {
      const openedTask = normalizeOpenedTaskProject(action.task, action.project)
      return {
        ...upsertOpenedTask(state, openedTask),
        currentProject: action.project === undefined ? state.currentProject : action.project,
        standaloneDeviceId:
          action.project === null
            ? (action.standaloneDeviceId ?? openedTask.device_id ?? state.standaloneDeviceId)
            : state.standaloneDeviceId,
        currentTask: openedTask,
        currentRuntimeTask: null,
      }
    }
    case 'runtime_task_opened':
      return {
        ...state,
        currentProject: action.project === undefined ? state.currentProject : action.project,
        currentTask: null,
        currentRuntimeTask: action.address,
      }
    case 'task_upserted':
      return upsertOpenedTask(
        state,
        state.currentTask?.id === action.task.id ? state.currentTask : action.task
      )
    case 'task_status_changed':
      return {
        ...state,
        currentTask:
          state.currentTask?.id === action.taskId
            ? { ...state.currentTask, status: action.status }
            : state.currentTask,
        projects: state.projects.map(project => ({
          ...project,
          tasks: project.tasks?.map(task =>
            task.task_id === action.taskId
              ? { ...task, task_status: action.status, status: action.status }
              : task
          ),
        })),
      }
    case 'current_task_model_selection_changed':
      return {
        ...state,
        currentTask: state.currentTask
          ? {
              ...state.currentTask,
              model_id: action.selection.modelName,
              force_override_bot_model_type: action.selection.modelType ?? null,
              model_options: action.selection.options ?? {},
            }
          : state.currentTask,
      }
    case 'current_task_cleared':
      return { ...state, currentTask: null, currentRuntimeTask: null }
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
