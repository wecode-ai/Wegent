// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  disconnectStandInProject,
  newStandInRole,
  roleIncludesProject,
  roleSelectsProject,
} from './personalStandIn'

const project = { id: 'one', store: 'local' as const }
const other = { id: 'two', store: 'local' as const }
const sameIdInCloud = { id: 'one', store: 'cloud' as const }

describe('project-only stand-in disabling', () => {
  it.each([true])(
    'preserves other projects and global enablement with allProjects=%s',
    allProjects => {
      const role = newStandInRole('mac', 'default')
      role.enabled = true
      role.collaboration = {
        ...role.collaboration,
        enabled: true,
        allProjects,
        projects: [project, other, sameIdInCloud],
      }
      const result = disconnectStandInProject(role, project)
      expect(result.enabled).toBe(true)
      expect(roleIncludesProject(result, project)).toBe(false)
      expect(roleIncludesProject(result, other)).toBe(true)
      expect(roleIncludesProject(result, sameIdInCloud)).toBe(true)
      expect(roleIncludesProject(role, project)).toBe(true)
      expect(disconnectStandInProject(result, project)).toBe(result)
    }
  )

  it('disconnects a selected project without changing the stand-in or source switches', () => {
    const role = newStandInRole('mac', 'project-agent')
    role.enabled = true
    role.collaboration = {
      ...role.collaboration,
      enabled: true,
      allProjects: false,
      projects: [project],
    }
    const result = disconnectStandInProject(role, project)
    expect(result.enabled).toBe(true)
    expect(result.collaboration.enabled).toBe(true)
    expect(roleIncludesProject(result, project)).toBe(false)
    expect(roleIncludesProject(role, project)).toBe(true)
  })
})

it.each([true, false])(
  'retains selected scope without activating a paused source (allProjects=%s)',
  allProjects => {
    const role = newStandInRole('mac')
    role.collaboration = {
      ...role.collaboration,
      allProjects,
      projects: [project],
      excludedProjects: [other],
    }
    expect(roleSelectsProject(role, project)).toBe(true)
    expect(roleSelectsProject(role, other)).toBe(false)
    expect(roleIncludesProject(role, project)).toBe(false)
    role.collaboration.enabled = true
    expect(roleIncludesProject(role, project)).toBe(true)
    expect(roleSelectsProject(role, sameIdInCloud)).toBe(allProjects)
  }
)
