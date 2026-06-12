import type { ProjectWithTasks } from '@/types/api'

export interface ProjectWorkspaceRootApi {
  getProjectWorkspaceRoot(deviceId: string): Promise<string>
}

export function configuredWorkspacePath(project: ProjectWithTasks): string | undefined {
  const config = project.config
  return config?.workspace?.localPath || config?.workspace?.checkoutPath || config?.path
}

export function executionDeviceId(project: ProjectWithTasks): string | undefined {
  const config = project.config
  return config?.execution?.deviceId || config?.device_id
}

function isGitWorkspace(project: ProjectWithTasks): boolean {
  return project.config?.workspace?.source === 'git'
}

function joinDevicePath(root: string, child: string): string {
  const normalizedRoot = root.trim().replace(/\/+$/, '') || '/'
  const normalizedChild = child.trim().replace(/^\/+/, '')
  if (!normalizedChild) return normalizedRoot
  return normalizedRoot === '/' ? `/${normalizedChild}` : `${normalizedRoot}/${normalizedChild}`
}

function executorWorkspaceRoot(projectWorkspaceRoot: string): string {
  const normalizedRoot = projectWorkspaceRoot.trim().replace(/\/+$/, '') || '/'
  if (normalizedRoot.split('/').pop() === 'projects') {
    return normalizedRoot.slice(0, normalizedRoot.lastIndexOf('/')) || '/'
  }
  return normalizedRoot
}

export async function resolveProjectWorkspacePath(
  project: ProjectWithTasks,
  deviceId: string,
  api: ProjectWorkspaceRootApi,
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
