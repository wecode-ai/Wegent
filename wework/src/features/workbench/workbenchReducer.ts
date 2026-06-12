import type {
  DeviceInfo,
  ModelSelectionConfig,
  ProjectTask,
  ProjectWithTasks,
  Task,
  Team,
  User,
  UserPreferences,
} from '@/types/api'
import type { DeviceSlotUpdatePayload } from '@/types/device-events'
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
  | {
      type: 'devices_refreshed'
      devices: DeviceInfo[]
      standaloneDeviceId?: string | null
    }
  | {
      type: 'device_slot_updated'
      payload: DeviceSlotUpdatePayload
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

function collectProjectTaskIds(projects: ProjectWithTasks[]): Set<number> {
  const ids = new Set<number>()
  for (const project of projects) {
    for (const task of project.tasks ?? []) {
      const taskId = normalizeTaskId(task.task_id)
      if (taskId !== undefined) ids.add(taskId)
    }
  }
  return ids
}

function normalizeTaskId(value: unknown): number | undefined {
  const taskId = Number(value)
  return Number.isInteger(taskId) && taskId > 0 ? taskId : undefined
}

function isSameTaskId(left: unknown, right: unknown): boolean {
  const leftTaskId = normalizeTaskId(left)
  const rightTaskId = normalizeTaskId(right)
  return leftTaskId !== undefined && leftTaskId === rightTaskId
}

function removeTaskFromProjects(
  projects: ProjectWithTasks[],
  taskId: number
): ProjectWithTasks[] {
  return projects.map(project => {
    if (!project.tasks?.some(task => isSameTaskId(task.task_id, taskId))) return project
    return {
      ...project,
      tasks: project.tasks.filter(task => !isSameTaskId(task.task_id, taskId)),
    }
  })
}

/**
 * Enforce that the "conversations" list (recentTasks) and the "projects" lists
 * are mutually exclusive. A task already grouped under a project must never
 * leak into recentTasks, even if the server momentarily reports project_id=0
 * for it (eventual consistency right after task creation).
 */
function normalizeListExclusivity(state: WorkbenchState): WorkbenchState {
  const projectTaskIds = collectProjectTaskIds(state.projects)
  if (projectTaskIds.size === 0) return state
  const dedupedRecentTasks = state.recentTasks.filter(
    task => !projectTaskIds.has(task.id)
  )
  if (dedupedRecentTasks.length === state.recentTasks.length) return state
  return { ...state, recentTasks: dedupedRecentTasks }
}

function keepDevicesOnTransientEmpty(
  currentDevices: DeviceInfo[],
  nextDevices: DeviceInfo[],
): DeviceInfo[] {
  if (nextDevices.length > 0) return nextDevices
  if (currentDevices.length > 0) return currentDevices
  return nextDevices
}

function getTaskStatus(task: Task): string {
  return task.status ?? task.task_status ?? ''
}

function normalizeTaskRuntimeStatus(task: Task): Task {
  const status = getTaskStatus(task)
  if (!status || task.status === status) return task
  return { ...task, status }
}

function toProjectTask(task: Task): ProjectTask {
  const status = getTaskStatus(task)
  return {
    id: task.id,
    task_id: task.id,
    task_title: task.title,
    task_status: status,
    title: task.title,
    status,
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
  const existingIndex = currentTasks.findIndex(task =>
    isSameTaskId(getTaskId(task), taskId)
  )
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
      // A project task must not linger in the standalone conversation list.
      recentTasks: state.recentTasks.filter(item => item.id !== task.id),
    }
  }

  return {
    ...state,
    recentTasks: upsertTask(state.recentTasks, task.id, task, item => item.id),
    // A standalone task must not linger in any project bucket.
    projects: removeTaskFromProjects(state.projects, task.id),
  }
}

function normalizeOpenedTaskProject(
  task: Task,
  project: ProjectWithTasks | null | undefined
): Task {
  const normalizedTask = normalizeTaskRuntimeStatus(task)
  if (project === undefined) return normalizedTask
  return {
    ...normalizedTask,
    project_id: project?.id ?? 0,
  }
}

function workListsIncludeTask(
  projects: ProjectWithTasks[],
  recentTasks: Task[],
  task: Task
): boolean {
  if (taskBelongsToProject(task)) {
    return projects.some(project =>
      project.id === task.project_id &&
      (project.tasks ?? []).some(projectTask =>
        isSameTaskId(projectTask.task_id, task.id)
      )
    )
  }

  return recentTasks.some(recentTask => isSameTaskId(recentTask.id, task.id))
}

export function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction
): WorkbenchState {
  switch (action.type) {
    case 'bootstrapped':
      return normalizeListExclusivity({
        ...state,
        user: action.user,
        defaultTeam: action.defaultTeam,
        projects: action.projects,
        devices: keepDevicesOnTransientEmpty(state.devices, action.devices),
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
      })
    case 'lists_refreshed': {
      const refreshedState = {
        ...state,
        projects: action.projects,
        devices: keepDevicesOnTransientEmpty(state.devices, action.devices),
        recentTasks: action.recentTasks,
        currentProject: state.currentProject
          ? action.projects.find(project => project.id === state.currentProject?.id) ?? null
          : null,
        standaloneDeviceId:
          action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
      }
      if (
        state.currentTask &&
        !workListsIncludeTask(action.projects, action.recentTasks, state.currentTask)
      ) {
        return normalizeListExclusivity(
          upsertOpenedTask(refreshedState, state.currentTask)
        )
      }
      return normalizeListExclusivity(refreshedState)
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
    case 'device_slot_updated':
      return {
        ...state,
        devices: state.devices.map(device =>
          device.device_id === action.payload.device_id
            ? {
                ...device,
                slot_used: action.payload.slot_used,
                slot_max: action.payload.slot_max ?? device.slot_max,
                running_tasks: action.payload.running_tasks ?? device.running_tasks,
                running_task_ids:
                  action.payload.running_task_ids ?? device.running_task_ids,
              }
            : device
        ),
      }
    case 'bootstrap_failed':
      return { ...state, isBootstrapping: false, error: action.error }
    case 'project_selected':
      return { ...state, currentProject: action.project, currentTask: null }
    case 'project_updated':
      return {
        ...state,
        currentProject:
          state.currentProject?.id === action.project.id
            ? action.project
            : state.currentProject,
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
    case 'task_opened':
      {
        const openedTask = normalizeOpenedTaskProject(action.task, action.project)
        return {
          ...upsertOpenedTask(state, openedTask),
          currentProject:
            action.project === undefined ? state.currentProject : action.project,
          standaloneDeviceId:
            action.project === null
              ? action.standaloneDeviceId ?? openedTask.device_id ?? state.standaloneDeviceId
              : state.standaloneDeviceId,
          currentTask: openedTask,
        }
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
          state.currentTask && isSameTaskId(state.currentTask.id, action.taskId)
            ? { ...state.currentTask, status: action.status }
            : state.currentTask,
        recentTasks: state.recentTasks.map(task =>
          isSameTaskId(task.id, action.taskId)
            ? { ...task, status: action.status }
            : task
        ),
        projects: state.projects.map(project => ({
          ...project,
          tasks: project.tasks?.map(task =>
            isSameTaskId(task.task_id, action.taskId)
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
