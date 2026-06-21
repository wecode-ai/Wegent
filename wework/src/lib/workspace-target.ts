import type {
  LocalTaskSummary,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  Task,
} from '@/types/api'
import {
  executionDeviceId,
  resolveProjectWorkspacePath,
  type ProjectWorkspaceRootApi,
} from '@/lib/project-workspace'
import type { WorkspaceTarget } from '@/types/workspace-files'

interface ResolveWorkspaceTargetOptions {
  currentTask: Task | null
  currentProject: ProjectWithTasks | null
  api: ProjectWorkspaceRootApi
}

interface ResolveRuntimeWorkspaceContextOptions {
  currentRuntimeTask: RuntimeTaskAddress | null
  projects: ProjectWithTasks[]
  runtimeWork: RuntimeWorkListResponse | null
}

export interface RuntimeWorkspaceContext {
  project: ProjectWithTasks | null
  workspaceTarget: WorkspaceTarget
}

function workspaceTargetFromTask(task: Task): WorkspaceTarget | null {
  const path = task.execution_workspace_path?.trim()
  const deviceId = task.device_id?.trim()
  if (!path || !deviceId) {
    return null
  }
  return { deviceId, path, source: 'task', taskId: task.id }
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
  currentTask,
  currentProject,
  api,
}: ResolveWorkspaceTargetOptions): Promise<WorkspaceTarget | null> {
  if (currentTask) {
    const currentTaskWorkspace = workspaceTargetFromTask(currentTask)
    if (currentTaskWorkspace) return currentTaskWorkspace
  }

  if (currentProject) {
    return projectWorkspaceTarget(currentProject, api)
  }

  return null
}

function workspaceTargetFromRuntimeTask(
  workspace: RuntimeDeviceWorkspace,
  task: LocalTaskSummary
): WorkspaceTarget {
  return {
    deviceId: workspace.deviceId,
    path: task.workspacePath || workspace.workspacePath,
    source: 'runtime',
  }
}

function runtimeTaskMatches(
  address: RuntimeTaskAddress,
  workspace: RuntimeDeviceWorkspace,
  task: LocalTaskSummary
) {
  if (workspace.deviceId !== address.deviceId || task.localTaskId !== address.localTaskId) {
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
      const task = workspace.localTasks.find(item =>
        runtimeTaskMatches(currentRuntimeTask, workspace, item)
      )
      if (!task) continue

      return {
        project: projects.find(project => project.id === projectWork.project.id) ?? null,
        workspaceTarget: workspaceTargetFromRuntimeTask(workspace, task),
      }
    }
  }

  for (const workspace of runtimeWork?.unmappedDeviceWorkspaces ?? []) {
    const task = workspace.localTasks.find(item =>
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
    },
  }
}

export function workspaceTargetKey(target: WorkspaceTarget | null): string {
  return target ? `${target.deviceId}:${target.path}:${target.source}:${target.taskId ?? ''}` : ''
}
