import type { ProjectWithTasks, Task } from '@/types/api'
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
