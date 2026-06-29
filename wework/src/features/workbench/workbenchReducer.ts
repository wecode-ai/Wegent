import type {
  DeviceWorkspaceResponse,
  DeviceInfo,
  LocalTaskSummary,
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
  isBootstrapping: true,
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
  | {
      type: 'runtime_task_optimistic_upserted'
      project: ProjectWithTasks | null
      workspace: RuntimeDeviceWorkspace
      task: LocalTaskSummary
    }
  | {
      type: 'runtime_task_optimistic_removed'
      address: RuntimeTaskAddress
    }
  | { type: 'current_task_cleared' }
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

function mergeRuntimeWorkPreservingTaskOrder(
  current: RuntimeWorkListResponse | null | undefined,
  next: RuntimeWorkListResponse | null
): RuntimeWorkListResponse | null {
  if (!current || !next) return next

  const nextProjectTaskKeys = new Map(
    next.projects.map(projectWork => [
      runtimeProjectUiId(projectWork.project),
      collectRuntimeTaskKeys(projectWork.deviceWorkspaces),
    ])
  )
  const nextChatTaskKeys = collectRuntimeTaskKeys(next.chats)

  const mergeProjectWorkspace = (
    projectWork: RuntimeProjectWork,
    workspace: RuntimeDeviceWorkspace
  ): RuntimeDeviceWorkspace => {
    const currentWorkspace = findMatchingProjectRuntimeWorkspace(current, projectWork, workspace)
    if (!currentWorkspace) return workspace
    const resolvedTaskKeys =
      nextProjectTaskKeys.get(runtimeProjectUiId(projectWork.project)) ?? new Set<string>()
    return {
      ...workspace,
      localTasks: mergeRuntimeLocalTasks(
        currentWorkspace.localTasks,
        workspace.localTasks,
        workspace.deviceId,
        resolvedTaskKeys
      ),
    }
  }

  const mergeChatWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => {
    const currentWorkspace = findMatchingChatRuntimeWorkspace(current, workspace)
    if (!currentWorkspace) return workspace
    return {
      ...workspace,
      localTasks: mergeRuntimeLocalTasks(
        currentWorkspace.localTasks,
        workspace.localTasks,
        workspace.deviceId,
        nextChatTaskKeys
      ),
    }
  }

  const projects = preserveMissingOptimisticProjects(
    current.projects,
    next.projects.map(project => ({
      ...project,
      deviceWorkspaces: project.deviceWorkspaces.map(workspace =>
        mergeProjectWorkspace(project, workspace)
      ),
    })),
    nextProjectTaskKeys
  )
  const chats = preserveMissingOptimisticWorkspaces(
    current.chats,
    next.chats.map(mergeChatWorkspace),
    nextChatTaskKeys
  )
  const merged = {
    ...next,
    projects,
    chats,
  }

  return {
    ...merged,
    totalLocalTasks: countRuntimeWorkTasks(merged),
  }
}

function findMatchingProjectRuntimeWorkspace(
  runtimeWork: RuntimeWorkListResponse,
  projectWork: RuntimeProjectWork,
  target: RuntimeDeviceWorkspace
): RuntimeDeviceWorkspace | null {
  const projectKey = runtimeProjectUiId(projectWork.project)
  const currentProject = runtimeWork.projects.find(
    project => runtimeProjectUiId(project.project) === projectKey
  )
  return (
    currentProject?.deviceWorkspaces.find(workspace =>
      runtimeWorkspaceMatches(workspace, target)
    ) ?? null
  )
}

function findMatchingChatRuntimeWorkspace(
  runtimeWork: RuntimeWorkListResponse,
  target: RuntimeDeviceWorkspace
): RuntimeDeviceWorkspace | null {
  return runtimeWork.chats.find(workspace => runtimeWorkspaceMatches(workspace, target)) ?? null
}

function runtimeWorkspaceMatches(
  current: RuntimeDeviceWorkspace,
  target: RuntimeDeviceWorkspace
): boolean {
  if (current.deviceId !== target.deviceId || current.workspacePath !== target.workspacePath) {
    return false
  }
  if (
    current.workspaceKind &&
    target.workspaceKind &&
    current.workspaceKind !== target.workspaceKind
  ) {
    return false
  }
  if (
    current.projectId != null &&
    target.projectId != null &&
    current.projectId !== target.projectId
  ) {
    return false
  }
  if (current.worktreeId && target.worktreeId && current.worktreeId !== target.worktreeId) {
    return false
  }
  return true
}

function mergeRuntimeLocalTasks(
  currentTasks: RuntimeDeviceWorkspace['localTasks'],
  nextTasks: RuntimeDeviceWorkspace['localTasks'],
  deviceId: string,
  resolvedTaskKeys: ReadonlySet<string>
) {
  const nextById = new Map(nextTasks.map(task => [task.localTaskId, task]))
  const merged = currentTasks
    .map(
      task =>
        nextById.get(task.localTaskId) ??
        (isOptimisticRuntimeTask(task) && !resolvedTaskKeys.has(runtimeTaskKey(deviceId, task))
          ? task
          : null)
    )
    .filter((task): task is RuntimeDeviceWorkspace['localTasks'][number] => Boolean(task))
  const mergedIds = new Set(merged.map(task => task.localTaskId))
  nextTasks.forEach(task => {
    if (!mergedIds.has(task.localTaskId)) {
      merged.push(task)
    }
  })
  return merged
}

function isOptimisticRuntimeTask(task: LocalTaskSummary): boolean {
  return task.status === 'creating'
}

function runtimeTaskKey(deviceId: string, task: Pick<LocalTaskSummary, 'localTaskId'>): string {
  return `${deviceId}\0${task.localTaskId}`
}

function collectRuntimeTaskKeys(workspaces: RuntimeDeviceWorkspace[]): Set<string> {
  const keys = new Set<string>()
  workspaces.forEach(workspace => {
    workspace.localTasks.forEach(task => {
      keys.add(runtimeTaskKey(workspace.deviceId, task))
    })
  })
  return keys
}

function optimisticWorkspaceOnly(
  workspace: RuntimeDeviceWorkspace,
  resolvedTaskKeys: ReadonlySet<string>
): RuntimeDeviceWorkspace | null {
  const localTasks = workspace.localTasks.filter(
    task =>
      isOptimisticRuntimeTask(task) &&
      !resolvedTaskKeys.has(runtimeTaskKey(workspace.deviceId, task))
  )
  return localTasks.length > 0 ? { ...workspace, localTasks } : null
}

function preserveMissingOptimisticWorkspaces(
  currentWorkspaces: RuntimeDeviceWorkspace[],
  nextWorkspaces: RuntimeDeviceWorkspace[],
  resolvedTaskKeys: ReadonlySet<string>
): RuntimeDeviceWorkspace[] {
  const mergedWorkspaces = [...nextWorkspaces]
  currentWorkspaces.forEach(currentWorkspace => {
    if (mergedWorkspaces.some(workspace => runtimeWorkspaceMatches(workspace, currentWorkspace))) {
      return
    }
    const optimisticWorkspace = optimisticWorkspaceOnly(currentWorkspace, resolvedTaskKeys)
    if (optimisticWorkspace) {
      mergedWorkspaces.push(optimisticWorkspace)
    }
  })
  return mergedWorkspaces
}

function preserveMissingOptimisticProjects(
  currentProjects: RuntimeProjectWork[],
  nextProjects: RuntimeProjectWork[],
  resolvedTaskKeysByProject: ReadonlyMap<number, ReadonlySet<string>>
): RuntimeProjectWork[] {
  const mergedProjects = [...nextProjects]
  currentProjects.forEach(currentProject => {
    const projectId = runtimeProjectUiId(currentProject.project)
    const resolvedTaskKeys = resolvedTaskKeysByProject.get(projectId) ?? new Set<string>()
    const existingIndex = mergedProjects.findIndex(
      project => runtimeProjectUiId(project.project) === projectId
    )
    if (existingIndex < 0) {
      const optimisticWorkspaces = currentProject.deviceWorkspaces
        .map(workspace => optimisticWorkspaceOnly(workspace, resolvedTaskKeys))
        .filter((workspace): workspace is RuntimeDeviceWorkspace => Boolean(workspace))
      if (optimisticWorkspaces.length > 0) {
        mergedProjects.push({
          ...currentProject,
          deviceWorkspaces: optimisticWorkspaces,
          totalLocalTasks: countRuntimeLocalTasks(optimisticWorkspaces),
        })
      }
      return
    }

    const deviceWorkspaces = preserveMissingOptimisticWorkspaces(
      currentProject.deviceWorkspaces,
      mergedProjects[existingIndex].deviceWorkspaces,
      resolvedTaskKeys
    )
    mergedProjects[existingIndex] = {
      ...mergedProjects[existingIndex],
      deviceWorkspaces,
      totalLocalTasks: countRuntimeLocalTasks(deviceWorkspaces),
    }
  })

  return mergedProjects.map(project => ({
    ...project,
    totalLocalTasks: countRuntimeLocalTasks(project.deviceWorkspaces),
  }))
}

function upsertRuntimeLocalTask(
  workspace: RuntimeDeviceWorkspace,
  task: LocalTaskSummary
): RuntimeDeviceWorkspace {
  return {
    ...workspace,
    localTasks: [
      task,
      ...workspace.localTasks.filter(item => item.localTaskId !== task.localTaskId),
    ],
  }
}

function upsertRuntimeWorkspace(
  workspaces: RuntimeDeviceWorkspace[],
  workspace: RuntimeDeviceWorkspace
): RuntimeDeviceWorkspace[] {
  const task = workspace.localTasks[0]
  if (!task) return workspaces
  const nextWorkspace = upsertRuntimeLocalTask(workspace, task)
  const existingIndex = workspaces.findIndex(item => runtimeWorkspaceMatches(item, workspace))
  if (existingIndex < 0) return [nextWorkspace, ...workspaces]

  return workspaces.map((item, index) => {
    if (index !== existingIndex) return item
    return upsertRuntimeLocalTask(
      {
        ...item,
        ...workspace,
        localTasks: item.localTasks,
      },
      task
    )
  })
}

function countRuntimeLocalTasks(workspaces: RuntimeDeviceWorkspace[]): number {
  return workspaces.reduce((total, workspace) => total + workspace.localTasks.length, 0)
}

function countRuntimeWorkTasks(runtimeWork: RuntimeWorkListResponse): number {
  return (
    runtimeWork.projects.reduce(
      (total, project) => total + countRuntimeLocalTasks(project.deviceWorkspaces),
      0
    ) + countRuntimeLocalTasks(runtimeWork.chats)
  )
}

function upsertOptimisticRuntimeTask(
  current: RuntimeWorkListResponse | null | undefined,
  project: ProjectWithTasks | null,
  workspace: RuntimeDeviceWorkspace,
  task: LocalTaskSummary
): RuntimeWorkListResponse {
  const currentRuntimeWork = current ?? {
    projects: [],
    chats: [],
    totalLocalTasks: 0,
  }
  const workspaceWithTask = {
    ...workspace,
    localTasks: [task],
  }

  if (!project) {
    const nextRuntimeWork = {
      ...currentRuntimeWork,
      chats: upsertRuntimeWorkspace(currentRuntimeWork.chats, workspaceWithTask),
    }
    return {
      ...nextRuntimeWork,
      totalLocalTasks: countRuntimeWorkTasks(nextRuntimeWork),
    }
  }

  const projectId = project.id
  let matchedProject = false
  const projects = currentRuntimeWork.projects.map(projectWork => {
    if (runtimeProjectUiId(projectWork.project) !== projectId) return projectWork
    matchedProject = true
    const deviceWorkspaces = upsertRuntimeWorkspace(projectWork.deviceWorkspaces, workspaceWithTask)
    return {
      ...projectWork,
      deviceWorkspaces,
      totalLocalTasks: countRuntimeLocalTasks(deviceWorkspaces),
    }
  })

  if (!matchedProject) {
    projects.unshift({
      project: {
        key: `project:${project.id}`,
        id: project.id,
        name: project.name,
        description: project.description,
        color: project.color,
      },
      deviceWorkspaces: [workspaceWithTask],
      totalLocalTasks: 1,
    })
  }

  const nextRuntimeWork = {
    ...currentRuntimeWork,
    projects,
  }
  return {
    ...nextRuntimeWork,
    totalLocalTasks: countRuntimeWorkTasks(nextRuntimeWork),
  }
}

function removeOptimisticRuntimeTask(
  current: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress
): RuntimeWorkListResponse | null {
  if (!current) return null

  const removeFromWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => ({
    ...workspace,
    localTasks: workspace.localTasks.filter(
      task =>
        task.localTaskId !== address.localTaskId ||
        !isOptimisticRuntimeTask(task) ||
        workspace.deviceId !== address.deviceId
    ),
  })
  const projects = current.projects.map(project => {
    const deviceWorkspaces = project.deviceWorkspaces.map(removeFromWorkspace)
    return {
      ...project,
      deviceWorkspaces,
      totalLocalTasks: countRuntimeLocalTasks(deviceWorkspaces),
    }
  })
  const chats = current.chats.map(removeFromWorkspace)
  const nextRuntimeWork = {
    ...current,
    projects,
    chats,
  }
  return {
    ...nextRuntimeWork,
    totalLocalTasks: countRuntimeWorkTasks(nextRuntimeWork),
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
      const runtimeWork =
        action.runtimeWork === undefined
          ? state.runtimeWork
          : mergeRuntimeWorkPreservingTaskOrder(state.runtimeWork, action.runtimeWork)
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
    case 'runtime_work_refreshed': {
      const runtimeWork = mergeRuntimeWorkPreservingTaskOrder(state.runtimeWork, action.runtimeWork)
      return {
        ...state,
        runtimeWork,
        currentProject: resolveCurrentProjectAfterRefresh(
          state.currentProject,
          state.projects,
          runtimeWork
        ),
        currentRuntimeTask: reconcileCurrentRuntimeTaskAddress(
          state.currentRuntimeTask,
          state.devices,
          runtimeWork
        ),
      }
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
    case 'current_task_cleared':
      return { ...state, currentRuntimeTask: null }
    case 'error_set':
      return { ...state, error: action.error }
  }
}
