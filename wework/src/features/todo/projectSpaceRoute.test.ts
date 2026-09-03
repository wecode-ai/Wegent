import { describe, expect, test } from 'vitest'
import {
  defaultProjectSpaceContentRoute,
  projectSpaceContentRoute,
  projectSpaceRefFromRoute,
  projectSpaceRouteMatchesProject,
  projectSpaceRouteParam,
  projectSpaceRouteRequestsDefaultProject,
} from './projectSpaceRoute'

describe('projectSpaceRoute', () => {
  test('builds and parses a concrete project-space route', () => {
    const project = { projectStore: 'local' as const, projectId: 'project-1' }
    const route = projectSpaceContentRoute(project)

    expect(route).toBe('/todo?projectStore=local&projectId=project-1')
    expect(projectSpaceRefFromRoute(route)).toEqual(project)
    expect(projectSpaceRouteParam(`${route}&itemId=issue-1`, 'itemId')).toBe('issue-1')
  })

  test('recognizes the unresolved default project-space route', () => {
    const route = defaultProjectSpaceContentRoute()

    expect(projectSpaceRouteRequestsDefaultProject(route)).toBe(true)
    expect(projectSpaceRefFromRoute(route)).toBeNull()
    expect(
      projectSpaceRouteMatchesProject(route, {
        projectStore: 'local',
        projectId: 'default-work-items',
      })
    ).toBe(true)
    expect(
      projectSpaceRouteMatchesProject(route, {
        projectStore: 'backend',
        projectId: 'default-work-items',
      })
    ).toBe(true)
  })

  test('does not treat the default placeholder as a named project', () => {
    expect(
      projectSpaceRouteMatchesProject(defaultProjectSpaceContentRoute(), {
        projectStore: 'local',
        projectId: 'project-1',
      })
    ).toBe(false)
  })

  test('keeps concrete local and backend projects distinct', () => {
    const route = projectSpaceContentRoute({
      projectStore: 'local',
      projectId: 'default-work-items',
    })

    expect(
      projectSpaceRouteMatchesProject(route, {
        projectStore: 'backend',
        projectId: 'default-work-items',
      })
    ).toBe(false)
  })
})
