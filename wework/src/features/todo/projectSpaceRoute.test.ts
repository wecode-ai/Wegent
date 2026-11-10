// @vitest-environment node

import { describe, expect, test } from 'vitest'
import {
  defaultProjectSpaceContentRoute,
  projectSpaceContentRoute,
  projectSpaceNavigationRoute,
  projectSpaceRefFromRoute,
  projectSpaceRouteMatchesProject,
  projectSpaceRouteParam,
  projectSpaceRouteRequestsDefaultProject,
  projectSpaceRouteTargetsDefaultWorkItems,
} from './projectSpaceRoute'

describe('projectSpaceRoute', () => {
  test('preserves the exact enabled surface query only for the same project', () => {
    const project = { projectStore: 'backend', projectId: '42' } as const
    const route = '/todo?view=gantt&surface=plan&mode=timeline&projectId=42&projectStore=backend'
    expect(projectSpaceNavigationRoute(project, route, { 'collab.projectSurfaces.v1': true })).toBe(
      route
    )
    expect(projectSpaceNavigationRoute(project, route, {})).toBe(projectSpaceContentRoute(project))
    expect(
      projectSpaceNavigationRoute({ ...project, projectId: '43' }, route, {
        'collab.projectSurfaces.v1': true,
      })
    ).toBe('/todo?projectStore=backend&projectId=43')
  })

  test('builds a route focused on one project-space item', () => {
    const route = projectSpaceContentRoute(
      { projectStore: 'backend', projectId: 'project-1' },
      'issue-1'
    )

    expect(route).toBe('/todo?projectStore=backend&projectId=project-1&itemId=issue-1')
    expect(projectSpaceRouteParam(route, 'itemId')).toBe('issue-1')
  })

  test('recognizes the unresolved default project-space route', () => {
    const route = defaultProjectSpaceContentRoute()

    expect(projectSpaceRouteRequestsDefaultProject(route)).toBe(true)
    expect(projectSpaceRouteTargetsDefaultWorkItems(route)).toBe(true)
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

  test('keeps concrete local and backend projects distinct', () => {
    const route = projectSpaceContentRoute({
      projectStore: 'local',
      projectId: 'default-work-items',
    })

    expect(projectSpaceRouteRequestsDefaultProject(route)).toBe(false)
    expect(projectSpaceRouteTargetsDefaultWorkItems(route)).toBe(true)
    expect(
      projectSpaceRouteMatchesProject(route, {
        projectStore: 'backend',
        projectId: 'default-work-items',
      })
    ).toBe(false)
  })
})
