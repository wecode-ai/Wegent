import type { ProjectWithTasks } from './execution-project'
export function isGitWorkspaceProject(project: ProjectWithTasks): boolean {
  return project.config?.mode === 'workspace' && project.config?.workspace?.source === 'git'
}
