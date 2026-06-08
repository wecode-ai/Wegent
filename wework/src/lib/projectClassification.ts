import type { ProjectWithTasks } from '@/types/api'

export function isGitWorkspaceProject(project: ProjectWithTasks): boolean {
  return (
    project.config?.mode === 'workspace' &&
    project.config?.workspace?.source === 'git'
  )
}

export function supportsGitWorktreeExecution(project: ProjectWithTasks): boolean {
  const config = project.config
  const workspace = config?.workspace
  const workspacePath = workspace?.localPath || workspace?.checkoutPath
  const deviceId = config?.execution?.deviceId || config?.device_id

  return Boolean(
    config?.mode === 'workspace' &&
      (config.execution?.targetType === 'local' || !config.execution) &&
      deviceId &&
      workspacePath,
  )
}
