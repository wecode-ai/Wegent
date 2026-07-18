import type {
  DeviceInfo,
  RuntimeTaskSummary,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'
import {
  executionDeviceId,
  resolveProjectWorkspacePath,
  type ProjectWorkspaceRootApi,
} from '@/lib/project-workspace'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import { LOCAL_WORKBENCH_DEVICE_ALIAS, resolveLocalWorkbenchDeviceId } from '@/lib/workbench-device'
import type { WorkspaceTarget } from '@/types/workspace-files'

interface ResolveWorkspaceTargetOptions {
  currentProject: ProjectWithTasks | null
  api: ProjectWorkspaceRootApi
}

interface ResolveRuntimeWorkspaceContextOptions {
  currentRuntimeTask: RuntimeTaskAddress | null
  projects: ProjectWithTasks[]
  runtimeWork: RuntimeWorkListResponse | null
}

interface ResolveProjectRuntimeWorkspaceTargetOptions {
  currentProject: ProjectWithTasks | null
  runtimeWork: RuntimeWorkListResponse | null
  selectedDeviceWorkspaceId?: number | null
}

export interface RuntimeWorkspaceContext {
  project: ProjectWithTasks | null
  workspaceTarget: WorkspaceTarget
}

export function createLocalFileWorkspaceTarget(
  filePath: string,
  devices: DeviceInfo[]
): WorkspaceTarget | null {
  const normalizedPath = filePath.trim().replace(/\\/g, '/')
  if (!normalizedPath.startsWith('/')) return null

  const separatorIndex = normalizedPath.lastIndexOf('/')
  const directoryPath = separatorIndex > 0 ? normalizedPath.slice(0, separatorIndex) : '/'
  const deviceId = resolveLocalWorkbenchDeviceId(devices, LOCAL_WORKBENCH_DEVICE_ALIAS)
  if (!deviceId) return null

  return {
    deviceId,
    path: directoryPath,
    source: 'runtime',
    workspaceSource: 'local',
  }
}

export function createLocalAttachmentWorkspaceTarget(
  filePath: string,
  devices: DeviceInfo[]
): WorkspaceTarget | null {
  const normalizedPath = filePath.trim().replace(/\\/g, '/')
  const isLocalAttachment =
    normalizedPath.includes('/.wegent-executor/workspace/attachments/') ||
    normalizedPath.includes('/.wegent/attachments/')
  return isLocalAttachment ? createLocalFileWorkspaceTarget(normalizedPath, devices) : null
}

async function projectWorkspaceTarget(
  project: ProjectWithTasks,
  api: ProjectWorkspaceRootApi
): Promise<WorkspaceTarget | null> {
  const deviceId = executionDeviceId(project)
  const workspacePath = deviceId
    ? await resolveProjectWorkspacePath(project, deviceId, api)
    : undefined
  if (!deviceId || !workspacePath) return null
  return { deviceId, path: workspacePath, source: 'project' }
}

export async function resolveWorkspaceTarget({
  currentProject,
  api,
}: ResolveWorkspaceTargetOptions): Promise<WorkspaceTarget | null> {
  if (currentProject) {
    return projectWorkspaceTarget(currentProject, api)
  }

  return null
}

function projectDeviceWorkspaces(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined
): RuntimeDeviceWorkspace[] {
  if (!projectId) return []
  const projectWork = runtimeWork?.projects.find(
    item => runtimeProjectUiId(item.project) === projectId
  )
  return projectWork?.deviceWorkspaces.filter(workspace => workspace.available) ?? []
}

function selectProjectDeviceWorkspace(
  workspaces: RuntimeDeviceWorkspace[],
  selectedDeviceWorkspaceId?: number | null
): RuntimeDeviceWorkspace | null {
  if (selectedDeviceWorkspaceId != null) {
    return workspaces.find(workspace => workspace.id === selectedDeviceWorkspaceId) ?? null
  }
  return workspaces.length === 1 ? workspaces[0] : null
}

export function resolveProjectRuntimeWorkspaceTarget({
  currentProject,
  runtimeWork,
  selectedDeviceWorkspaceId,
}: ResolveProjectRuntimeWorkspaceTargetOptions): WorkspaceTarget | null {
  const workspace = selectProjectDeviceWorkspace(
    projectDeviceWorkspaces(runtimeWork, currentProject?.id),
    selectedDeviceWorkspaceId
  )
  const workspacePath = workspace?.workspacePath.trim()
  if (!workspace || !workspacePath) return null

  return {
    deviceId: workspace.deviceId,
    path: workspacePath,
    source: 'project',
    ...(workspace.workspaceSource !== undefined
      ? { workspaceSource: workspace.workspaceSource }
      : {}),
  }
}

function workspaceTargetFromRuntimeTask(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): WorkspaceTarget {
  const workspacePath =
    workspace.workspaceKind === 'worktree' || workspace.worktreeId
      ? workspace.workspacePath
      : task.workspacePath || workspace.workspacePath

  return {
    deviceId: workspace.deviceId,
    path: workspacePath,
    source: 'runtime',
    taskId: task.taskId,
    ...(workspace.workspaceSource !== undefined
      ? { workspaceSource: workspace.workspaceSource }
      : {}),
  }
}

function runtimeTaskMatches(
  address: RuntimeTaskAddress,
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
) {
  if (workspace.deviceId !== address.deviceId || task.taskId !== address.taskId) {
    return false
  }

  const addressPath = address.workspacePath?.trim()
  if (!addressPath) return true

  const taskPath = task.workspacePath || workspace.workspacePath
  return addressPath === taskPath || addressPath === workspace.workspacePath
}

export function resolveRuntimeWorkspaceContext({
  currentRuntimeTask,
  projects,
  runtimeWork,
}: ResolveRuntimeWorkspaceContextOptions): RuntimeWorkspaceContext | null {
  if (!currentRuntimeTask) return null

  for (const projectWork of runtimeWork?.projects ?? []) {
    for (const workspace of projectWork.deviceWorkspaces) {
      const task = workspace.tasks.find(item =>
        runtimeTaskMatches(currentRuntimeTask, workspace, item)
      )
      if (!task) continue

      return {
        project:
          projects.find(project => project.id === runtimeProjectUiId(projectWork.project)) ??
          runtimeProjectToProject(projectWork),
        workspaceTarget: workspaceTargetFromRuntimeTask(workspace, task),
      }
    }
  }

  for (const workspace of runtimeWork?.chats ?? []) {
    const task = workspace.tasks.find(item =>
      runtimeTaskMatches(currentRuntimeTask, workspace, item)
    )
    if (!task) continue

    return {
      project: null,
      workspaceTarget: workspaceTargetFromRuntimeTask(workspace, task),
    }
  }

  const workspacePath = currentRuntimeTask.workspacePath?.trim()
  if (!workspacePath) return null
  return {
    project: null,
    workspaceTarget: {
      deviceId: currentRuntimeTask.deviceId,
      path: workspacePath,
      source: 'runtime',
      taskId: currentRuntimeTask.taskId,
    },
  }
}

export function workspaceTargetKey(target: WorkspaceTarget | null): string {
  return target
    ? `${target.deviceId}:${target.path}:${target.source}:${target.taskId ?? ''}:${target.workspaceSource ?? ''}`
    : ''
}
