import type { ProjectWithTasks } from '@/types/api'
import { configuredWorkspacePath, executionDeviceId } from './project-workspace'

export function isGitWorkspaceProject(project: ProjectWithTasks): boolean {
  return project.config?.mode === 'workspace' && project.config?.workspace?.source === 'git'
}

export function isWorktreeEligibleProject(project: ProjectWithTasks): boolean {
  return project.config?.mode === 'workspace'
}

export function supportsGitWorktreeExecution(project: ProjectWithTasks): boolean {
  const workspacePath = configuredWorkspacePath(project)
  const deviceId = executionDeviceId(project)

  return Boolean(isWorktreeEligibleProject(project) && deviceId && workspacePath)
}
