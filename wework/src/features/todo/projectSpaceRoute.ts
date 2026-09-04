import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import type { RuntimeProjectSpaceRef } from '@/types/api'
import { sameProjectSpace } from './projectSpaceSelection'

export function projectSpaceRouteParam(contentRoute: string, name: string): string | null {
  const searchIndex = contentRoute.indexOf('?')
  if (searchIndex < 0) return null
  return new URLSearchParams(contentRoute.slice(searchIndex + 1)).get(name)
}

export function projectSpaceRefFromRoute(contentRoute: string): RuntimeProjectSpaceRef | null {
  const projectId = projectSpaceRouteParam(contentRoute, 'projectId')
  const projectStore = projectSpaceRouteParam(contentRoute, 'projectStore')
  if (!projectId || (projectStore !== 'local' && projectStore !== 'backend')) return null
  return { projectId, projectStore }
}

export function projectSpaceRouteRequestsDefaultProject(contentRoute: string): boolean {
  return (
    projectSpaceRouteParam(contentRoute, 'projectId') === DEFAULT_WORK_ITEM_PROJECT_ID &&
    projectSpaceRouteParam(contentRoute, 'projectStore') === null
  )
}

export function projectSpaceRouteMatchesProject(
  contentRoute: string,
  project: RuntimeProjectSpaceRef
): boolean {
  const routedProject = projectSpaceRefFromRoute(contentRoute)
  if (routedProject) return sameProjectSpace(routedProject, project)
  return (
    project.projectId === DEFAULT_WORK_ITEM_PROJECT_ID &&
    projectSpaceRouteRequestsDefaultProject(contentRoute)
  )
}

export function projectSpaceContentRoute(project: RuntimeProjectSpaceRef): string {
  const params = new URLSearchParams()
  params.set('projectStore', project.projectStore)
  params.set('projectId', project.projectId)
  return `/todo?${params.toString()}`
}

export function defaultProjectSpaceContentRoute(): string {
  return `/todo?projectId=${DEFAULT_WORK_ITEM_PROJECT_ID}`
}
