import type { ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'

export function resolveLocalTodoProjects(
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null
): ProjectWithTasks[] {
  const resolved = new Map(projects.map(project => [project.id, project]))

  for (const runtimeProject of runtimeWork?.projects ?? []) {
    const project = runtimeProject.project
    if (
      typeof project.id !== 'number' ||
      project.kind === 'remote' ||
      project.source === 'remote_project'
    ) {
      continue
    }
    const existing = resolved.get(project.id)
    resolved.set(project.id, {
      ...existing,
      id: project.id,
      name: project.name,
      description: project.description ?? existing?.description,
      color: project.color ?? existing?.color,
      tasks: existing?.tasks ?? [],
    })
  }

  return [...resolved.values()]
}
