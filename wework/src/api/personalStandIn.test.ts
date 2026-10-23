import { describe, expect, it } from 'vitest'
import { disconnectStandInProject, newStandInRole, roleIncludesProject } from './personalStandIn'

const project = { id: 'one', store: 'local' as const }
const other = { id: 'two', store: 'local' as const }
const sameIdInCloud = { id: 'one', store: 'cloud' as const }

describe('project-only stand-in disabling', () => {
  it.each([false, true])(
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

  it('disables the collaboration source of a project-bound agent without turning off its global switch', () => {
    const role = newStandInRole('mac', 'project-agent')
    role.enabled = true
    role.agentId = 'reviewer'
    role.agentProject = project
    role.collaboration = {
      ...role.collaboration,
      enabled: true,
      allProjects: false,
      projects: [project],
    }
    const result = disconnectStandInProject(role, project)
    expect(result.enabled).toBe(true)
    expect(result.collaboration.enabled).toBe(false)
    expect(result.agentId).toBe('reviewer')
    expect(roleIncludesProject(result, project)).toBe(false)
    expect(roleIncludesProject(role, project)).toBe(true)
  })
})
