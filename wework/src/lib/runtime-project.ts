import type { RuntimeProjectRef, RuntimeProjectWork } from '@/types/api'

export function runtimeProjectKey(project: RuntimeProjectRef): string {
  return project.key || (project.id != null ? `legacy:${project.id}` : project.name)
}

export function runtimeProjectWorkKey(projectWork: RuntimeProjectWork): string {
  return runtimeProjectKey(projectWork.project)
}

export function runtimeProjectUiId(project: RuntimeProjectRef): number {
  if (project.id != null) return project.id

  const key = runtimeProjectKey(project)
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0
  }
  return (hash % 1_000_000_000) + 1
}
