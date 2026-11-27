import { updateRuntimeWorkProject } from '@/lib/runtime-project-update'
import type {
  DeviceWorkspaceResponse,
  DeviceInfo,
  RuntimeSupervisorState,
  RuntimeTaskSummary,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeProjectAiSettings,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeTaskPinRequest,
  RuntimeWorkListResponse,
  User,
  UserPreferences,
} from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import type { DeviceSlotUpdatePayload } from '@/types/device-events'
import {
  normalizeRuntimeWorkspacePath,
  runtimeProjectToProject,
  runtimeProjectUiId,
} from '@/lib/runtime-project'
import { workbenchDeviceMatchesId } from '@/lib/workbench-device'
import {
  getDefaultProjectDeviceWorkspaceId,
  mergeRuntimeTaskAddresses,
  mergeRuntimeTaskHandles,
  removeRuntimeTasks,
  runtimeWorkContainsTask,
  updateRuntimeWorkTask,
  updateRuntimeWorkTaskPinned,
  updateRuntimeWorkTaskTitle,
} from './workbenchRuntimeHelpers'
import { debugRuntimeSidebarState, summarizeRuntimeWorkTaskIds } from './runtimeSidebarDiagnostics'
import { removeRuntimeProject, type RuntimeProjectRemoval } from './workbenchDataRefreshHelpers'

import {
  keepDevicesOnTransientEmpty,
  reuseSnapshot,
  updateRuntimeWorkDeviceStatus,
  mergeRuntimeWorkPreservingTaskOrder,
  upsertOptimisticRuntimeTask,
  removeOptimisticRuntimeTask,
  reconcileCurrentRuntimeTaskAddress,
  resolveCurrentProjectAfterRefresh,
  reconcileProjectWorkspaceSelection,
  upsertOpenedRuntimeWorkspace,
  findRuntimeProjectByWorkspace,
  upsertPreparedRuntimeWorkspace,
} from './workbenchInventoryState'
type WorkbenchDeviceStatus = DeviceInfo['status']

export function isRuntimeProjectSelectionRemoved(
  state: Pick<WorkbenchState, 'currentProject' | 'currentRuntimeTask' | 'runtimeWork'>,
  projectId: number,
  runtimeWork: RuntimeWorkListResponse | null
): boolean {
  const currentProjectId = state.currentProject?.id
  if (currentProjectId === projectId) return true
  if (
    currentProjectId != null &&
    state.runtimeWork?.projects.some(
      project => runtimeProjectUiId(project.project) === currentProjectId
    ) &&
    !runtimeWork?.projects.some(project => runtimeProjectUiId(project.project) === currentProjectId)
  ) {
    return true
  }
  return Boolean(
    state.currentRuntimeTask &&
    state.runtimeWork &&
    runtimeWorkContainsTask(state.runtimeWork, state.currentRuntimeTask) &&
    (!runtimeWork || !runtimeWorkContainsTask(runtimeWork, state.currentRuntimeTask))
  )
}

export const initialWorkbenchState: WorkbenchState = {
  user: null,
  projects: [],
  devices: [],
  runtimeWork: null,
  runtimeWorkLoad: { phase: 'loading', error: null },
  currentProject: null,
  currentRuntimeTask: null,
  standaloneChatKey: 0,
  selectedDeviceWorkspaceId: null,
  pendingProjectWorkspaceProjectId: null,
  standaloneDeviceId: null,
  standaloneWorkspacePath: null,
  isBootstrapping: true,
  error: null,
}

export type WorkbenchAction =
  | { type: 'runtime_work_scope_reset' }
  | { type: 'runtime_work_load_started' }
  | { type: 'runtime_work_load_succeeded' }
  | { type: 'runtime_work_load_failed'; error: string }
  | {
      type: 'bootstrapped'
      user: User
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
      user?: User
      standaloneDeviceId?: string | null
      standaloneWorkspacePath?: string | null
    }
  | {
      type: 'runtime_work_refreshed'
      runtimeWork: RuntimeWorkListResponse
    }
  | {
      type: 'runtime_task_pin_changed'
      deviceId: string
      threadId: string
      pinned: boolean
    }
  | {
      type: 'device_status_changed'
      deviceId: string
      status: WorkbenchDeviceStatus
      name?: string | null
    }
  | {
      type: 'device_slot_updated'
      payload: DeviceSlotUpdatePayload
    }
  | { type: 'bootstrap_failed'; error: string }
  | { type: 'project_created'; project: ProjectWithTasks }
  | { type: 'project_selected'; project: ProjectWithTasks }
  | {
      type: 'runtime_local_project_updated'
      source?: 'local_project'
      deviceId: string
      projectKey: string
      name: string
      roots: string[]
      defaultProjectSpace: RuntimeProjectSpaceRef | null
      aiSettings: RuntimeProjectAiSettings | null
    }
  | {
      type: 'runtime_project_removed'
      removal: RuntimeProjectRemoval
    }
  | { type: 'device_workspace_prepared'; mapping: DeviceWorkspaceResponse }
  | {
      type: 'runtime_workspace_opened'
      deviceId: string
      workspacePath: string
      label?: string | null
    }
  | {
      type: 'project_workspace_selected'
      project: ProjectWithTasks
      deviceWorkspaceId?: number | null
      startFreshChat?: boolean
    }
  | { type: 'project_updated'; project: ProjectWithTasks }
  | { type: 'project_removed'; projectId: number }
  | { type: 'user_updated'; user: User }
  | {
      type: 'project_cleared'
      standaloneDeviceId?: string | null
      standaloneWorkspacePath?: string | null
      startFreshChat?: boolean
    }
  | { type: 'user_preferences_updated'; preferences: UserPreferences }
  | { type: 'blank_chat_committed'; standaloneChatKey: number }
  | {
      type: 'runtime_task_opened'
      address: RuntimeTaskAddress
      project: ProjectWithTasks | null
    }
  | {
      type: 'runtime_task_address_reconciled'
      previousAddress: RuntimeTaskAddress
      address: RuntimeTaskAddress
    }
  | {
      type: 'runtime_task_optimistic_upserted'
      project: ProjectWithTasks | null
      workspace: RuntimeDeviceWorkspace
      task: RuntimeTaskSummary
    }
  | {
      type: 'runtime_task_optimistic_removed'
      address: RuntimeTaskAddress
    }
  | {
      type: 'runtime_task_title_updated'
      address: RuntimeTaskAddress
      title: string
    }
  | {
      type: 'runtime_task_pinned_updated'
      request: RuntimeTaskPinRequest
    }
  | {
      type: 'runtime_task_supervisor_updated'
      address: RuntimeTaskAddress
      supervisor: RuntimeSupervisorState | null
    }
  | {
      type: 'runtime_task_snapshot_updated'
      address: RuntimeTaskAddress
      task: RuntimeTaskSummary
    }
  | { type: 'runtime_tasks_archived'; addresses: RuntimeTaskAddress[] }
  | { type: 'current_task_cleared' }
  | { type: 'error_set'; error: string | null }

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  const next = reduceWorkbenchState(state, action)
  if (state.currentProject !== next.currentProject || action.type.startsWith('project_')) {
    debugRuntimeSidebarState('project-selection-transition', {
      action: action.type,
      previousProjectId: state.currentProject?.id ?? null,
      nextProjectId: next.currentProject?.id ?? null,
      projectIds: next.projects.map(project => project.id),
      runtimeProjectIds: next.runtimeWork?.projects.map(project =>
        runtimeProjectUiId(project.project)
      ),
      selectedDeviceWorkspaceId: next.selectedDeviceWorkspaceId,
      standaloneChatKey: next.standaloneChatKey,
    })
  }
  return next
}

function userForNavigationRefresh(current: User | null, incoming?: User): User | null {
  // Navigation responses do not own profile or preference updates for an existing account.
  return incoming && incoming.id !== current?.id ? incoming : current
}

function reduceWorkbenchState(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case 'runtime_work_scope_reset':
      return {
        ...state,
        user: null,
        projects: [],
        devices: [],
        runtimeWork: null,
        runtimeWorkLoad: { phase: 'loading', error: null },
        currentProject: null,
        currentRuntimeTask: null,
        selectedDeviceWorkspaceId: null,
        pendingProjectWorkspaceProjectId: null,
        standaloneDeviceId: null,
        standaloneWorkspacePath: null,
        isBootstrapping: true,
      }
    case 'runtime_work_load_started':
      return {
        ...state,
        runtimeWorkLoad: {
          phase: state.runtimeWork ? 'refreshing' : 'loading',
          error: null,
        },
      }
    case 'runtime_work_load_failed':
      return { ...state, runtimeWorkLoad: { phase: 'error', error: action.error } }
    case 'runtime_work_load_succeeded':
      return { ...state, runtimeWorkLoad: { phase: 'ready', error: null } }
    case 'bootstrapped': {
      const devices = keepDevicesOnTransientEmpty(state.devices, action.devices)
      const runtimeWork = action.runtimeWork === undefined ? state.runtimeWork : action.runtimeWork
      const currentRuntimeTask = reconcileCurrentRuntimeTaskAddress(
        state.currentRuntimeTask,
        devices,
        runtimeWork
      )
      const currentProject =
        action.currentProject === undefined ? state.currentProject : action.currentProject
      return {
        ...state,
        user: userForNavigationRefresh(state.user, action.user),
        projects: action.projects,
        devices,
        runtimeWork,
        currentRuntimeTask,
        currentProject: currentRuntimeTask
          ? resolveCurrentProjectAfterRefresh(
              currentProject,
              action.projects,
              runtimeWork,
              currentRuntimeTask
            )
          : currentProject,
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
      const projects = reuseSnapshot(state.projects, action.projects)
      const runtimeWork =
        action.runtimeWork === undefined
          ? state.runtimeWork
          : mergeRuntimeWorkPreservingTaskOrder(state.runtimeWork, action.runtimeWork)
      const currentRuntimeTask = reconcileCurrentRuntimeTaskAddress(
        state.currentRuntimeTask,
        devices,
        runtimeWork
      )
      const refreshedState = {
        ...state,
        projects,
        devices,
        runtimeWork,
        currentRuntimeTask,
        currentProject: reuseSnapshot(
          state.currentProject,
          resolveCurrentProjectAfterRefresh(
            state.currentProject,
            projects,
            runtimeWork,
            currentRuntimeTask
          )
        ),
        standaloneDeviceId:
          state.standaloneWorkspacePath || action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
        standaloneWorkspacePath:
          action.standaloneWorkspacePath === undefined
            ? state.standaloneWorkspacePath
            : action.standaloneWorkspacePath,
      }
      refreshedState.selectedDeviceWorkspaceId = reconcileProjectWorkspaceSelection(
        state,
        runtimeWork
      )
      debugRuntimeSidebarState('reducer-lists-refreshed', () => ({
        incomingTaskIds: summarizeRuntimeWorkTaskIds(action.runtimeWork ?? null),
        previousTaskIds: summarizeRuntimeWorkTaskIds(state.runtimeWork ?? null),
        mergedTaskIds: summarizeRuntimeWorkTaskIds(runtimeWork),
      }))
      return reuseSnapshot(state, refreshedState)
    }
    case 'devices_refreshed': {
      const devices = keepDevicesOnTransientEmpty(state.devices, action.devices)
      return reuseSnapshot(state, {
        ...state,
        user: userForNavigationRefresh(state.user, action.user),
        isBootstrapping: action.user ? false : state.isBootstrapping,
        devices,
        currentRuntimeTask: reconcileCurrentRuntimeTaskAddress(
          state.currentRuntimeTask,
          devices,
          state.runtimeWork
        ),
        standaloneDeviceId:
          state.standaloneWorkspacePath || action.standaloneDeviceId === undefined
            ? state.standaloneDeviceId
            : action.standaloneDeviceId,
        standaloneWorkspacePath:
          action.standaloneWorkspacePath === undefined
            ? state.standaloneWorkspacePath
            : action.standaloneWorkspacePath,
      })
    }
    case 'runtime_work_refreshed': {
      const runtimeWork = mergeRuntimeWorkPreservingTaskOrder(state.runtimeWork, action.runtimeWork)
      const currentRuntimeTask = reconcileCurrentRuntimeTaskAddress(
        state.currentRuntimeTask,
        state.devices,
        runtimeWork
      )
      debugRuntimeSidebarState('reducer-runtime-work-refreshed', () => ({
        incomingTaskIds: summarizeRuntimeWorkTaskIds(action.runtimeWork),
        previousTaskIds: summarizeRuntimeWorkTaskIds(state.runtimeWork ?? null),
        mergedTaskIds: summarizeRuntimeWorkTaskIds(runtimeWork),
      }))
      return reuseSnapshot(state, {
        ...state,
        runtimeWork,
        currentProject: reuseSnapshot(
          state.currentProject,
          resolveCurrentProjectAfterRefresh(
            state.currentProject,
            state.projects,
            runtimeWork,
            currentRuntimeTask
          )
        ),
        currentRuntimeTask,
        selectedDeviceWorkspaceId: reconcileProjectWorkspaceSelection(state, runtimeWork),
      })
    }
    case 'runtime_task_pin_changed': {
      return {
        ...state,
        runtimeWork: updateRuntimeWorkTaskPinned(state.runtimeWork, action),
      }
    }
    case 'device_status_changed': {
      const matchedDevice =
        state.devices.find(device => workbenchDeviceMatchesId(device, action.deviceId)) ?? undefined
      return {
        ...state,
        devices: state.devices.map(device => {
          if (!workbenchDeviceMatchesId(device, action.deviceId)) return device
          return {
            ...device,
            name: action.name || device.name,
            status: action.status,
          }
        }),
        runtimeWork: updateRuntimeWorkDeviceStatus(
          state.runtimeWork,
          action.deviceId,
          action.status,
          matchedDevice
        ),
      }
    }
    case 'device_slot_updated': {
      const { device_id: deviceId, ...slotState } = action.payload
      return {
        ...state,
        devices: state.devices.map(device => {
          if (!workbenchDeviceMatchesId(device, deviceId)) return device
          return {
            ...device,
            ...slotState,
          }
        }),
      }
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
    case 'runtime_local_project_updated':
      return {
        ...state,
        runtimeWork: state.runtimeWork
          ? updateRuntimeWorkProject(state.runtimeWork, action, state.devices)
          : state.runtimeWork,
      }
    case 'runtime_project_removed': {
      const runtimeWork = state.runtimeWork
        ? removeRuntimeProject(state.runtimeWork, action.removal)
        : null
      const removedCurrentProject = isRuntimeProjectSelectionRemoved(
        state,
        action.removal.projectId,
        runtimeWork
      )
      return {
        ...state,
        runtimeWork,
        currentProject: removedCurrentProject ? null : state.currentProject,
        selectedDeviceWorkspaceId: removedCurrentProject ? null : state.selectedDeviceWorkspaceId,
        pendingProjectWorkspaceProjectId: removedCurrentProject
          ? null
          : state.pendingProjectWorkspaceProjectId,
        currentRuntimeTask: removedCurrentProject ? null : state.currentRuntimeTask,
      }
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
    case 'runtime_workspace_opened': {
      const runtimeWork = upsertOpenedRuntimeWorkspace(
        state.runtimeWork,
        state.devices,
        action.deviceId,
        action.workspacePath,
        action.label
      )
      const runtimeProject = findRuntimeProjectByWorkspace(
        runtimeWork,
        action.deviceId,
        action.workspacePath
      )
      const selectedWorkspace = runtimeProject?.deviceWorkspaces.find(
        workspace =>
          workspace.deviceId === action.deviceId.trim() &&
          normalizeRuntimeWorkspacePath(workspace.workspacePath) ===
            normalizeRuntimeWorkspacePath(action.workspacePath)
      )
      return {
        ...state,
        runtimeWork,
        currentProject: runtimeProject
          ? runtimeProjectToProject(runtimeProject)
          : state.currentProject,
        selectedDeviceWorkspaceId: selectedWorkspace?.id ?? null,
        pendingProjectWorkspaceProjectId: null,
        standaloneDeviceId: action.deviceId,
        standaloneWorkspacePath: normalizeRuntimeWorkspacePath(action.workspacePath),
        currentRuntimeTask: null,
        standaloneChatKey: state.standaloneChatKey + 1,
      }
    }
    case 'project_workspace_selected': {
      const deviceWorkspaceId =
        action.deviceWorkspaceId === undefined
          ? getDefaultProjectDeviceWorkspaceId(state.runtimeWork, action.project.id)
          : action.deviceWorkspaceId
      return {
        ...state,
        currentProject: action.project,
        selectedDeviceWorkspaceId: deviceWorkspaceId,
        pendingProjectWorkspaceProjectId: deviceWorkspaceId === null ? action.project.id : null,
        standaloneWorkspacePath: null,
        currentRuntimeTask: null,
        standaloneChatKey: action.startFreshChat
          ? state.standaloneChatKey + 1
          : state.standaloneChatKey,
      }
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
    case 'project_removed':
      return {
        ...state,
        currentProject: state.currentProject?.id === action.projectId ? null : state.currentProject,
        projects: state.projects.filter(project => project.id !== action.projectId),
      }
    case 'user_updated':
      return {
        ...state,
        user: action.user,
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
        standaloneChatKey: action.startFreshChat
          ? state.standaloneChatKey + 1
          : state.standaloneChatKey,
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
    case 'blank_chat_committed':
      if (state.standaloneChatKey !== action.standaloneChatKey) {
        return state
      }
      return {
        ...state,
        standaloneChatKey: state.standaloneChatKey + 1,
      }
    case 'runtime_task_opened':
      return {
        ...state,
        currentProject: action.project,
        currentRuntimeTask: mergeRuntimeTaskAddresses(state.currentRuntimeTask, action.address),
      }
    case 'runtime_task_address_reconciled': {
      const currentRuntimeTask = state.currentRuntimeTask
      if (
        !currentRuntimeTask ||
        currentRuntimeTask.deviceId !== action.previousAddress.deviceId ||
        currentRuntimeTask.taskId !== action.previousAddress.taskId
      ) {
        return state
      }
      const runtimeHandle = mergeRuntimeTaskHandles(
        currentRuntimeTask.runtimeHandle,
        action.address.runtimeHandle
      )
      return {
        ...state,
        currentRuntimeTask: {
          ...currentRuntimeTask,
          ...action.address,
          ...(runtimeHandle ? { runtimeHandle } : {}),
        },
      }
    }
    case 'runtime_task_optimistic_upserted':
      return {
        ...state,
        runtimeWork: upsertOptimisticRuntimeTask(
          state.runtimeWork,
          action.project,
          action.workspace,
          action.task
        ),
      }
    case 'runtime_task_optimistic_removed':
      return {
        ...state,
        runtimeWork: removeOptimisticRuntimeTask(state.runtimeWork, action.address),
      }
    case 'runtime_task_title_updated':
      return {
        ...state,
        runtimeWork: updateRuntimeWorkTaskTitle(state.runtimeWork, action.address, action.title),
      }
    case 'runtime_task_pinned_updated':
      return {
        ...state,
        runtimeWork: updateRuntimeWorkTaskPinned(state.runtimeWork, action.request),
      }
    case 'runtime_task_supervisor_updated':
      return {
        ...state,
        runtimeWork: updateRuntimeWorkTask(state.runtimeWork, action.address, {
          supervisor: action.supervisor,
        }),
      }
    case 'runtime_task_snapshot_updated':
      return {
        ...state,
        runtimeWork: updateRuntimeWorkTask(state.runtimeWork, action.address, action.task),
      }
    case 'runtime_tasks_archived':
      return {
        ...state,
        runtimeWork: state.runtimeWork
          ? removeRuntimeTasks(state.runtimeWork, action.addresses)
          : null,
      }
    case 'current_task_cleared':
      return {
        ...state,
        currentRuntimeTask: null,
      }
    case 'error_set':
      return { ...state, error: action.error }
  }
}
