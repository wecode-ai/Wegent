import type { DeviceInfo, ProjectTask, ProjectWithTasks, Task, Team, User } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'

export const initialWorkbenchState: WorkbenchState = {
  user: null,
  defaultTeam: null,
  projects: [],
  devices: [],
  recentTasks: [],
  currentProject: null,
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
      recentTasks: Task[]
      currentProject?: ProjectWithTasks | null
      standaloneDeviceId?: string | null
    }
  | {
      type: 'lists_refreshed'
      projects: ProjectWithTasks[]
      devices: DeviceInfo[]
      recentTasks: Task[]
      standaloneDeviceId?: string | null
    }
  | { type: 'bootstrap_failed'; error: string }
  | { type: 'project_selected'; project: ProjectWithTasks }
  | { type: 'project_cleared'; standaloneDeviceId?: string | null }
  | {
      type: 'task_opened'
      task: Task
      project?: ProjectWithTasks | null
      standaloneDeviceId?: string | null
    }
  | { type: 'task_status_changed'; taskId: number; status: string }
  | { type: 'current_task_cleared' }
  | { type: 'input_changed'; input: string }
  | { type: 'sending_started' }
  | { type: 'sending_finished' }
  | { type: 'error_set'; error: string | null }

function taskBelongsToProject(task: Task): boolean {
  return Boolean(task.project_id && task.project_id > 0)
}

function toProjectTask(task: Task): ProjectTask {
  return {
    id: task.id,
    task_id: task.id,
    task_title: task.title,
    task_status: task.status,
    title: task.title,
    status: task.status,
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
    recentTasks: upsertTask(state.recentTasks, task.id, task, item => item.id),
  }
}

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
        currentProject:
          action.currentProject === undefined
            ? state.currentProject
            : action.currentProject,
        standaloneDeviceId:
          action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
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
        standaloneDeviceId:
          action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
      }
    case 'bootstrap_failed':
      return { ...state, isBootstrapping: false, error: action.error }
    case 'project_selected':
      return { ...state, currentProject: action.project, currentTask: null }
    case 'project_cleared':
      return {
        ...state,
        currentProject: null,
        standaloneDeviceId:
          action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
        currentTask: null,
      }
    case 'task_opened':
      return {
        ...upsertOpenedTask(state, action.task),
        currentProject:
          action.project === undefined ? state.currentProject : action.project,
        standaloneDeviceId:
          action.project === null
            ? action.standaloneDeviceId ?? action.task.device_id ?? state.standaloneDeviceId
            : state.standaloneDeviceId,
        currentTask: action.task,
      }
    case 'task_status_changed':
      return {
        ...state,
        currentTask:
          state.currentTask?.id === action.taskId
            ? { ...state.currentTask, status: action.status }
            : state.currentTask,
        recentTasks: state.recentTasks.map(task =>
          task.id === action.taskId ? { ...task, status: action.status } : task
        ),
        projects: state.projects.map(project => ({
          ...project,
          tasks: project.tasks?.map(task =>
            task.task_id === action.taskId
              ? { ...task, task_status: action.status, status: action.status }
              : task
          ),
        })),
      }
    case 'current_task_cleared':
      return { ...state, currentTask: null }
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
