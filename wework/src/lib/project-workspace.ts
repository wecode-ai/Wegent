import type { ProjectWithTasks } from '@/types/api'
import { executorWorkspaceRoot, joinDevicePath } from './device-workspace-path'

export interface ProjectWorkspaceRootApi {
  getProjectWorkspaceRoot(deviceId: string): Promise<string>
}

export function configuredWorkspacePath(project: ProjectWithTasks): string | undefined {
  const config = project.config
  const workspace = config?.workspace
  if (workspace?.source === 'git') {
    return workspace.checkoutPath || config?.path
  }
  return workspace?.localPath || workspace?.checkoutPath || config?.path
}

export function executionDeviceId(project: ProjectWithTasks): string | undefined {
  const config = project.config
  return config?.execution?.deviceId || config?.device_id
}

function isGitWorkspace(project: ProjectWithTasks): boolean {
  return project.config?.workspace?.source === 'git'
}

export async function resolveProjectWorkspacePath(
  project: ProjectWithTasks,
  deviceId: string,
  api: ProjectWorkspaceRootApi
): Promise<string | undefined> {
  const path = configuredWorkspacePath(project)
  if (!path || !isGitWorkspace(project) || path.startsWith('/')) {
    return path
  }

  const workspaceRoot = await api.getProjectWorkspaceRoot(deviceId)
  if (path.startsWith('projects/')) {
    return joinDevicePath(executorWorkspaceRoot(workspaceRoot), path)
  }
  return joinDevicePath(workspaceRoot, path)
}
