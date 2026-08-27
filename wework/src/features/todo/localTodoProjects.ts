import type { ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'
import { runtimeProjectToProject } from '@/lib/runtime-project'

export function resolveLocalTodoProjects(
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null
): ProjectWithTasks[] {
  const resolved = new Map(projects.map(project => [project.id, project]))

  for (const runtimeProject of runtimeWork?.projects ?? []) {
    const project = runtimeProject.project
    if (project.kind === 'remote' || project.source === 'remote_project') {
      continue
    }
    const localProject = runtimeProjectToProject(runtimeProject)
    const existing = resolved.get(localProject.id)
    resolved.set(localProject.id, {
      ...existing,
      ...localProject,
      description: localProject.description ?? existing?.description,
      color: localProject.color ?? existing?.color,
      config: localProject.config ?? existing?.config,
      tasks: existing?.tasks ?? [],
    })
  }

  return [...resolved.values()]
}
