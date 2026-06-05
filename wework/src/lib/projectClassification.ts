import type { ProjectWithTasks } from '@/types/api'

export function isGitWorkspaceProject(project: ProjectWithTasks): boolean {
  return (
    project.config?.mode === 'workspace' &&
    project.config?.workspace?.source === 'git'
  )
}
