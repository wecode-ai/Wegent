import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  loadProjectSpaceCodeWorkspacePreference,
  saveProjectSpaceCodeWorkspacePreference,
} from './projectSpaceCodeWorkspacePreference'

const project = {
  projectStore: 'backend' as const,
  projectId: 'project-11',
}

describe('projectSpaceCodeWorkspacePreference', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('keeps mappings isolated by user and project space', () => {
    saveProjectSpaceCodeWorkspacePreference(1, project, {
      localProjectId: 91,
      deviceWorkspaceId: 201,
    })

    expect(loadProjectSpaceCodeWorkspacePreference(1, project)).toEqual({
      localProjectId: 91,
      deviceWorkspaceId: 201,
    })
    expect(loadProjectSpaceCodeWorkspacePreference(2, project)).toBeNull()
    expect(
      loadProjectSpaceCodeWorkspacePreference(1, {
        projectStore: 'backend',
        projectId: 'project-12',
      })
    ).toBeNull()
  })

  it('overwrites the mapping after a later successful selection', () => {
    saveProjectSpaceCodeWorkspacePreference(1, project, {
      localProjectId: 91,
      deviceWorkspaceId: 201,
    })
    saveProjectSpaceCodeWorkspacePreference(1, project, {
      localProjectId: 92,
      deviceWorkspaceId: 202,
    })

    expect(loadProjectSpaceCodeWorkspacePreference(1, project)).toEqual({
      localProjectId: 92,
      deviceWorkspaceId: 202,
    })
  })

  it('ignores malformed stored values', () => {
    localStorage.setItem(
      'wework.project-space-code-workspace:v1:1:backend:project-11',
      JSON.stringify({ localProjectId: '91', deviceWorkspaceId: 201 })
    )

    expect(loadProjectSpaceCodeWorkspacePreference(1, project)).toBeNull()
  })

  it('does not fail task creation when the device cannot persist the mapping', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
    })

    expect(() =>
      saveProjectSpaceCodeWorkspacePreference(1, project, {
        localProjectId: 91,
        deviceWorkspaceId: 201,
      })
    ).not.toThrow()
  })
})
