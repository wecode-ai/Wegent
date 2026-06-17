import type { ProjectWithTasks, Task } from '@/types/api'
import {
  executionDeviceId,
  resolveProjectWorkspacePath,
  type ProjectWorkspaceRootApi,
} from '@/lib/project-workspace'
import type { WorkbenchMessage } from '@/types/workbench'
import type { WorkspaceTarget } from '@/types/workspace-files'

interface ResolveWorkspaceTargetOptions {
  currentTask: Task | null
  currentProject: ProjectWithTasks | null
  messages: WorkbenchMessage[]
  api: ProjectWorkspaceRootApi
}

function workspaceTargetFromMessage(message: WorkbenchMessage): WorkspaceTarget | null {
  const fileChanges = message.fileChanges
  if (
    fileChanges?.status !== 'active' ||
    !fileChanges.device_id ||
    !fileChanges.workspace_path
  ) {
    return null
  }
  return {
    deviceId: fileChanges.device_id,
    path: fileChanges.workspace_path,
    source: 'task',
  }
}

function latestTaskWorkspace(
  currentTask: Task,
  messages: WorkbenchMessage[],
): WorkspaceTarget | null {
  let latestUnscopedTarget: WorkspaceTarget | null = null

  for (const message of [...messages].reverse()) {
    const target = workspaceTargetFromMessage(message)
    if (!target) continue

    if (message.taskId === currentTask.id) {
      return target
    }
    if (message.taskId == null && !latestUnscopedTarget) {
      latestUnscopedTarget = target
    }
  }

  return latestUnscopedTarget
}

async function projectWorkspaceTarget(
  project: ProjectWithTasks,
  api: ProjectWorkspaceRootApi,
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
  messages,
  api,
}: ResolveWorkspaceTargetOptions): Promise<WorkspaceTarget | null> {
  if (currentProject) {
    return projectWorkspaceTarget(currentProject, api)
  }
  if (currentTask) {
    const taskWorkspace = latestTaskWorkspace(currentTask, messages)
    if (taskWorkspace) return taskWorkspace
  }
  return null
}
