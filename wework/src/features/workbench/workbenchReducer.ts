import type {
  DeviceWorkspaceResponse,
  DeviceInfo,
  RuntimeTaskSummary,
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
import {
  normalizeRuntimeWorkspacePath,
  runtimeProjectToProject,
  runtimeProjectUiId,
  standaloneRuntimeProjectKey,
} from '@/lib/runtime-project'
import { workbenchDeviceMatchesId } from '@/lib/workbench-device'
import { getRuntimeTaskWorkspacePath, removeRuntimeTasks } from './workbenchRuntimeHelpers'
import { debugRuntimeSidebarState, summarizeRuntimeWorkTaskIds } from './runtimeSidebarDiagnostics'

type WorkbenchDeviceStatus = DeviceInfo['status']

const OPTIMISTIC_TASK_PRESERVE_MS = 2 * 60 * 1000

export const initialWorkbenchState: WorkbenchState = {
  user: null,
  defaultTeam: null,
  projects: [],
  devices: [],
  runtimeWork: null,
  currentProject: null,
  currentRuntimeTask: null,
  activeRuntimeTasks: [],
  standaloneChatKey: 0,
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
  | { type: 'runtime_project_removed'; projectId: number }
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
      deviceWorkspaceId: number | null
      startFreshChat?: boolean
    }
  | { type: 'project_updated'; project: ProjectWithTasks }
  | { type: 'project_removed'; projectId: number }
  | {
      type: 'project_cleared'
      standaloneDeviceId?: string | null
      standaloneWorkspacePath?: string | null
      startFreshChat?: boolean
    }
  | { type: 'user_preferences_updated'; preferences: UserPreferences }
  | { type: 'standalone_device_preference_changed'; standaloneDeviceId: string | null }
  | { type: 'blank_chat_committed' }
  | {
      type: 'runtime_task_opened'
      address: RuntimeTaskAddress
      project: ProjectWithTasks | null
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
  | { type: 'runtime_tasks_archived'; addresses: RuntimeTaskAddress[] }
  | { type: 'runtime_task_started'; address: RuntimeTaskAddress }
  | { type: 'runtime_task_settled'; address: RuntimeTaskAddress }
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
  status: WorkbenchDeviceStatus,
  device?: DeviceInfo
): RuntimeWorkListResponse | null {
  if (!runtimeWork) return null

  const updateWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => {
    const matchesDevice =
      workspace.deviceId === deviceId ||
      workspace.remoteHostId === deviceId ||
      Boolean(
        device &&
        (workbenchDeviceMatchesId(device, workspace.deviceId) ||
          (workspace.remoteHostId && workbenchDeviceMatchesId(device, workspace.remoteHostId)))
      )
    if (!matchesDevice) return workspace
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
      tasks: mergeRuntimeTasks(
        currentWorkspace.tasks,
        workspace.tasks,
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
      tasks: mergeRuntimeTasks(
        currentWorkspace.tasks,
        workspace.tasks,
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
    totalTasks: countRuntimeWorkTasks(merged),
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

function mergeRuntimeTasks(
  currentTasks: RuntimeDeviceWorkspace['tasks'],
  nextTasks: RuntimeDeviceWorkspace['tasks'],
  deviceId: string,
  resolvedTaskKeys: ReadonlySet<string>
) {
  const nextById = new Map(nextTasks.map(task => [task.taskId, task]))
  const merged = currentTasks
    .map(task => {
      const nextTask = nextById.get(task.taskId)
      if (nextTask) {
        return nextTask
      }
      if (
        isFreshOptimisticRuntimeTask(task) &&
        !resolvedTaskKeys.has(runtimeTaskKey(deviceId, task))
      ) {
        return task
      }
      return null
    })
    .filter((task): task is RuntimeDeviceWorkspace['tasks'][number] => Boolean(task))
  const mergedIds = new Set(merged.map(task => task.taskId))
  nextTasks.forEach(task => {
    if (!mergedIds.has(task.taskId)) {
      merged.push(task)
    }
  })
  return merged
}

function isOptimisticRuntimeTask(task: RuntimeTaskSummary): boolean {
  return task.status === 'creating' || (task.optimistic === true && task.status === 'failed')
}

function isFreshOptimisticRuntimeTask(task: RuntimeTaskSummary): boolean {
  if (!isOptimisticRuntimeTask(task)) return false
  const rawTimestamp = task.updatedAt ?? task.createdAt
  const timestamp = typeof rawTimestamp === 'number' ? rawTimestamp : Date.parse(rawTimestamp ?? '')
  return Number.isNaN(timestamp) || Date.now() - timestamp < OPTIMISTIC_TASK_PRESERVE_MS
}

function runtimeTaskKey(deviceId: string, task: Pick<RuntimeTaskSummary, 'taskId'>): string {
  return `${deviceId}\0${task.taskId}`
}

function collectRuntimeTaskKeys(workspaces: RuntimeDeviceWorkspace[]): Set<string> {
  const keys = new Set<string>()
  workspaces.forEach(workspace => {
    workspace.tasks.forEach(task => {
      keys.add(runtimeTaskKey(workspace.deviceId, task))
    })
  })
  return keys
}

function optimisticWorkspaceOnly(
  workspace: RuntimeDeviceWorkspace,
  resolvedTaskKeys: ReadonlySet<string>
): RuntimeDeviceWorkspace | null {
  const tasks = workspace.tasks.filter(
    task =>
      isFreshOptimisticRuntimeTask(task) &&
      !resolvedTaskKeys.has(runtimeTaskKey(workspace.deviceId, task))
  )
  return tasks.length > 0 ? { ...workspace, tasks } : null
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
          totalTasks: countRuntimeTasks(optimisticWorkspaces),
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
      totalTasks: countRuntimeTasks(deviceWorkspaces),
    }
  })

  return mergedProjects.map(project => ({
    ...project,
    totalTasks: countRuntimeTasks(project.deviceWorkspaces),
  }))
}

function upsertRuntimeTask(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): RuntimeDeviceWorkspace {
  return {
    ...workspace,
    tasks: [task, ...workspace.tasks.filter(item => item.taskId !== task.taskId)],
  }
}

function upsertRuntimeWorkspace(
  workspaces: RuntimeDeviceWorkspace[],
  workspace: RuntimeDeviceWorkspace
): RuntimeDeviceWorkspace[] {
  const task = workspace.tasks[0]
  if (!task) return workspaces
  const nextWorkspace = upsertRuntimeTask(workspace, task)
  const existingIndex = workspaces.findIndex(item => runtimeWorkspaceMatches(item, workspace))
  if (existingIndex < 0) return [nextWorkspace, ...workspaces]

  return workspaces.map((item, index) => {
    if (index !== existingIndex) return item
    return upsertRuntimeTask(
      {
        ...item,
        ...workspace,
        tasks: item.tasks,
      },
      task
    )
  })
}

function countRuntimeTasks(workspaces: RuntimeDeviceWorkspace[]): number {
  return workspaces.reduce((total, workspace) => total + workspace.tasks.length, 0)
}

function countRuntimeWorkTasks(runtimeWork: RuntimeWorkListResponse): number {
  return (
    runtimeWork.projects.reduce(
      (total, project) => total + countRuntimeTasks(project.deviceWorkspaces),
      0
    ) + countRuntimeTasks(runtimeWork.chats)
  )
}

function upsertOptimisticRuntimeTask(
  current: RuntimeWorkListResponse | null | undefined,
  project: ProjectWithTasks | null,
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): RuntimeWorkListResponse {
  const currentRuntimeWork = current ?? {
    projects: [],
    chats: [],
    totalTasks: 0,
  }
  const workspaceWithTask = {
    ...workspace,
    tasks: [task],
  }

  if (!project) {
    const nextRuntimeWork = {
      ...currentRuntimeWork,
      chats: upsertRuntimeWorkspace(currentRuntimeWork.chats, workspaceWithTask),
    }
    return {
      ...nextRuntimeWork,
      totalTasks: countRuntimeWorkTasks(nextRuntimeWork),
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
      totalTasks: countRuntimeTasks(deviceWorkspaces),
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
      totalTasks: 1,
    })
  }

  const nextRuntimeWork = {
    ...currentRuntimeWork,
    projects,
  }
  return {
    ...nextRuntimeWork,
    totalTasks: countRuntimeWorkTasks(nextRuntimeWork),
  }
}

function removeOptimisticRuntimeTask(
  current: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress
): RuntimeWorkListResponse | null {
  if (!current) return null

  const removeFromWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => ({
    ...workspace,
    tasks: workspace.tasks.filter(
      task =>
        task.taskId !== address.taskId ||
        !isOptimisticRuntimeTask(task) ||
        workspace.deviceId !== address.deviceId
    ),
  })
  const projects = current.projects.map(project => {
    const deviceWorkspaces = project.deviceWorkspaces.map(removeFromWorkspace)
    return {
      ...project,
      deviceWorkspaces,
      totalTasks: countRuntimeTasks(deviceWorkspaces),
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
    totalTasks: countRuntimeWorkTasks(nextRuntimeWork),
  }
}

function sameRuntimeTaskActivity(left: RuntimeTaskAddress, right: RuntimeTaskAddress): boolean {
  if (left.deviceId !== right.deviceId || left.taskId !== right.taskId) return false
  if (!left.workspacePath || !right.workspacePath) return true
  return left.workspacePath === right.workspacePath
}

function upsertActiveRuntimeTask(
  current: RuntimeTaskAddress[],
  address: RuntimeTaskAddress
): RuntimeTaskAddress[] {
  return [
    ...current.filter(activeAddress => !sameRuntimeTaskActivity(activeAddress, address)),
    address,
  ]
}

function updateRuntimeTaskRunning(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress,
  running: boolean
): RuntimeWorkListResponse | null {
  if (!runtimeWork) return null

  const updateWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => ({
    ...workspace,
    tasks: workspace.tasks.map(task => {
      const taskAddress: RuntimeTaskAddress = {
        deviceId: workspace.deviceId,
        taskId: task.taskId,
        workspacePath: getRuntimeTaskWorkspacePath(workspace, task),
      }
      if (!sameRuntimeTaskActivity(taskAddress, address) || task.running === running) return task
      return { ...task, running }
    }),
  })

  return {
    ...runtimeWork,
    projects: runtimeWork.projects.map(project => ({
      ...project,
      deviceWorkspaces: project.deviceWorkspaces.map(updateWorkspace),
    })),
    chats: runtimeWork.chats.map(updateWorkspace),
  }
}

function findRuntimeTaskAddressByTaskId(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  taskId: string,
  deviceId?: string
): RuntimeTaskAddress | null {
  if (!runtimeWork) return null

  let match: RuntimeTaskAddress | null = null
  const workspaces = [
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
    ...runtimeWork.chats,
  ]

  for (const workspace of workspaces) {
    if (deviceId && workspace.deviceId !== deviceId) continue
    const task = workspace.tasks.find(task => task.taskId === taskId)
    if (!task) continue

    const address = {
      deviceId: workspace.deviceId,
      taskId,
      workspacePath: getRuntimeTaskWorkspacePath(workspace, task),
      ...(task.taskId ? { taskId: task.taskId } : {}),
      ...(task.threadId ? { threadId: task.threadId } : {}),
      ...(task.runtimeHandle ? { runtimeHandle: task.runtimeHandle } : {}),
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
  const hydratedCurrentDeviceTask = findRuntimeTaskAddressByTaskId(
    runtimeWork,
    currentRuntimeTask.taskId,
    currentRuntimeTask.deviceId
  )
  if (hydratedCurrentDeviceTask) {
    return {
      ...currentRuntimeTask,
      ...(hydratedCurrentDeviceTask.threadId
        ? { threadId: hydratedCurrentDeviceTask.threadId }
        : {}),
      ...(hydratedCurrentDeviceTask.runtimeHandle
        ? { runtimeHandle: hydratedCurrentDeviceTask.runtimeHandle }
        : {}),
    }
  }
  if (devices.some(device => device.device_id === currentRuntimeTask.deviceId)) {
    return currentRuntimeTask
  }
  return (
    findRuntimeTaskAddressByTaskId(runtimeWork, currentRuntimeTask.taskId) ?? currentRuntimeTask
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
    tasks: [],
  }
}

function runtimeWorkspaceLabel(workspacePath: string, label?: string | null): string {
  const trimmedLabel = label?.trim()
  if (trimmedLabel) return trimmedLabel
  return workspacePath.split('/').filter(Boolean).at(-1) || workspacePath
}

function runtimeWorkspaceFromOpenedWorkspace(
  deviceId: string,
  workspacePath: string,
  label: string,
  devices: DeviceInfo[]
): RuntimeDeviceWorkspace {
  const device = devices.find(item => item.device_id === deviceId)
  return {
    id: null,
    projectId: null,
    deviceId,
    deviceName: device?.name ?? deviceId,
    deviceStatus: device?.status ?? null,
    available: device ? device.status !== 'offline' : true,
    workspacePath,
    workspaceKind: 'workspace',
    label,
    workspaceSource: 'local',
    mapped: true,
    tasks: [],
  }
}

function upsertOpenedRuntimeWorkspace(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  devices: DeviceInfo[],
  deviceId: string,
  workspacePath: string,
  label?: string | null
): RuntimeWorkListResponse {
  const currentRuntimeWork = runtimeWork ?? {
    projects: [],
    chats: [],
    totalTasks: 0,
  }
  const normalizedDeviceId = deviceId.trim()
  const normalizedWorkspacePath = normalizeRuntimeWorkspacePath(workspacePath)
  const projectLabel = runtimeWorkspaceLabel(normalizedWorkspacePath, label)
  const nextWorkspace = runtimeWorkspaceFromOpenedWorkspace(
    normalizedDeviceId,
    normalizedWorkspacePath,
    projectLabel,
    devices
  )
  const projectKey = standaloneRuntimeProjectKey(normalizedWorkspacePath)
  const remainingProjects = currentRuntimeWork.projects
    .map(projectWork => ({
      ...projectWork,
      deviceWorkspaces: projectWork.deviceWorkspaces.filter(
        workspace =>
          !(
            workspace.deviceId === normalizedDeviceId &&
            normalizeRuntimeWorkspacePath(workspace.workspacePath) === normalizedWorkspacePath
          )
      ),
    }))
    .filter(projectWork => projectWork.deviceWorkspaces.length > 0)
  const projects = [
    {
      project: {
        key: projectKey,
        stateDeviceId: normalizedDeviceId,
        name: projectLabel,
      },
      deviceWorkspaces: [nextWorkspace],
      totalTasks: 0,
    },
    ...remainingProjects,
  ]
  const nextRuntimeWork = {
    ...currentRuntimeWork,
    projects,
    chats: currentRuntimeWork.chats.filter(
      workspace =>
        !(
          workspace.deviceId === normalizedDeviceId &&
          normalizeRuntimeWorkspacePath(workspace.workspacePath) === normalizedWorkspacePath
        )
    ),
  }

  return {
    ...nextRuntimeWork,
    totalTasks: countRuntimeWorkTasks(nextRuntimeWork),
  }
}

function findRuntimeProjectByWorkspace(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  deviceId: string,
  workspacePath: string
): RuntimeProjectWork | null {
  const normalizedDeviceId = deviceId.trim()
  const normalizedWorkspacePath = normalizeRuntimeWorkspacePath(workspacePath)
  if (!normalizedDeviceId || !normalizedWorkspacePath) return null

  return (
    runtimeWork?.projects.find(projectWork =>
      projectWork.deviceWorkspaces.some(
        workspace =>
          workspace.deviceId === normalizedDeviceId &&
          normalizeRuntimeWorkspacePath(workspace.workspacePath) === normalizedWorkspacePath
      )
    ) ?? null
  )
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
    totalTasks: 0,
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
        {
          project: projectRef,
          deviceWorkspaces: [nextWorkspace],
        },
        ...currentRuntimeWork.projects,
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
      debugRuntimeSidebarState('reducer-lists-refreshed', {
        incomingTaskIds: summarizeRuntimeWorkTaskIds(action.runtimeWork ?? null),
        previousTaskIds: summarizeRuntimeWorkTaskIds(state.runtimeWork ?? null),
        mergedTaskIds: summarizeRuntimeWorkTaskIds(runtimeWork),
      })
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
      debugRuntimeSidebarState('reducer-runtime-work-refreshed', {
        incomingTaskIds: summarizeRuntimeWorkTaskIds(action.runtimeWork),
        previousTaskIds: summarizeRuntimeWorkTaskIds(state.runtimeWork ?? null),
        mergedTaskIds: summarizeRuntimeWorkTaskIds(runtimeWork),
      })
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
    case 'runtime_project_removed': {
      const removedCurrentProject = state.currentProject?.id === action.projectId
      const runtimeWork = state.runtimeWork
        ? {
            ...state.runtimeWork,
            projects: state.runtimeWork.projects.filter(
              project => runtimeProjectUiId(project.project) !== action.projectId
            ),
          }
        : state.runtimeWork
      return {
        ...state,
        runtimeWork: runtimeWork
          ? { ...runtimeWork, totalTasks: countRuntimeWorkTasks(runtimeWork) }
          : runtimeWork,
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
      return {
        ...state,
        runtimeWork,
        currentProject: runtimeProject
          ? runtimeProjectToProject(runtimeProject)
          : state.currentProject,
        selectedDeviceWorkspaceId: null,
        pendingProjectWorkspaceProjectId: null,
        standaloneDeviceId: action.deviceId,
        standaloneWorkspacePath: normalizeRuntimeWorkspacePath(action.workspacePath),
        currentRuntimeTask: null,
        standaloneChatKey: state.standaloneChatKey + 1,
      }
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
        standaloneChatKey: action.startFreshChat
          ? state.standaloneChatKey + 1
          : state.standaloneChatKey,
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
    case 'standalone_device_preference_changed':
      return {
        ...state,
        standaloneDeviceId: action.standaloneDeviceId,
        standaloneWorkspacePath: null,
      }
    case 'blank_chat_committed':
      return {
        ...state,
        standaloneChatKey: state.standaloneChatKey + 1,
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
    case 'runtime_tasks_archived':
      return {
        ...state,
        runtimeWork: state.runtimeWork
          ? removeRuntimeTasks(state.runtimeWork, action.addresses)
          : null,
      }
    case 'runtime_task_started':
      return {
        ...state,
        runtimeWork: updateRuntimeTaskRunning(state.runtimeWork, action.address, true),
        activeRuntimeTasks: upsertActiveRuntimeTask(state.activeRuntimeTasks, action.address),
      }
    case 'runtime_task_settled':
      return {
        ...state,
        runtimeWork: updateRuntimeTaskRunning(state.runtimeWork, action.address, false),
        activeRuntimeTasks: state.activeRuntimeTasks.filter(
          address => !sameRuntimeTaskActivity(address, action.address)
        ),
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
