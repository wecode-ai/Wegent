import type { ProjectWithTasks } from '@/types/api'
import { configuredWorkspacePath, executionDeviceId } from './project-workspace'

export function isGitWorkspaceProject(project: ProjectWithTasks): boolean {
  return project.config?.mode === 'workspace' && project.config?.workspace?.source === 'git'
}

export function supportsGitWorktreeExecution(project: ProjectWithTasks): boolean {
  const config = project.config
  const workspacePath = configuredWorkspacePath(project)
  const deviceId = executionDeviceId(project)

  return Boolean(
    config?.mode === 'workspace' &&
    (config.execution?.targetType === 'local' || !config.execution) &&
    deviceId &&
    workspacePath
  )
}
