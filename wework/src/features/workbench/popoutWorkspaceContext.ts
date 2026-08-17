import { runtimeProjectToProject } from '@/lib/runtime-project'
import type { ProjectExecutionMode, ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'

export function mergePopoutWorkspaceProjects(
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null | undefined
): ProjectWithTasks[] {
  const projectsById = new Map(
    [...projects, ...(runtimeWork?.projects ?? []).map(runtimeProjectToProject)].map(project => [
      project.id,
      project,
    ])
  )
  return Array.from(projectsById.values())
}

export function getPopoutComposerPlaceholder(
  projectName: string | null | undefined,
  executionMode: ProjectExecutionMode
):
  | { key: 'workbench.popout_projectless_placeholder' }
  | {
      key:
        | 'workbench.popout_current_workspace_placeholder'
        | 'workbench.popout_worktree_placeholder'
      values: { project: string }
    } {
  if (!projectName) {
    return { key: 'workbench.popout_projectless_placeholder' }
  }
  return {
    key:
      executionMode === 'git_worktree'
        ? 'workbench.popout_worktree_placeholder'
        : 'workbench.popout_current_workspace_placeholder',
    values: { project: projectName },
  }
}
