import { isGitWorkspaceProject, isWorktreeEligibleProject } from '@/lib/projectClassification'
import type { ProjectWorktreeAvailability } from '@/lib/worktree-availability'
import type { ProjectExecutionMode, ProjectWithTasks } from '@/types/api'

export function collaborationExecutionMode(
  project: ProjectWithTasks | null,
  policy?: 'git_worktree' | 'project',
  availability?: ProjectWorktreeAvailability
): ProjectExecutionMode {
  return policy !== 'project' &&
    project &&
    isWorktreeEligibleProject(project) &&
    (isGitWorkspaceProject(project) || availability?.reason !== 'not_git')
    ? 'git_worktree'
    : 'current_workspace'
}
