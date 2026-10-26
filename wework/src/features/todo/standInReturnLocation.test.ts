import { describe, expect, it } from 'vitest'
import type { CollaborationPlatformLocation, CollaborationProject } from '@wegent/collaboration'
import { standInReturnLocation } from './standInReturnLocation'

const project = {
  id: 'project-1',
  name: 'Project',
  project_store: 'local',
  workspace_id: 'workspace-from-project',
} as CollaborationProject

const returnLocation = {
  platformView: 'projects',
  collaborationDomain: 'local',
  rootView: 'projects',
  workspaceId: null,
  workspaceView: 'projects',
  projectId: 'project-1',
  projectView: 'board',
  issueId: 'issue-1',
} as CollaborationPlatformLocation

describe('standInReturnLocation', () => {
  it('restores a workspace that was not resolved before opening stand-in settings', () => {
    expect(standInReturnLocation(project, returnLocation)).toMatchObject({
      collaborationDomain: 'local',
      workspaceId: 'workspace-from-project',
      projectId: 'project-1',
      projectView: 'board',
      issueId: 'issue-1',
    })
  })

  it('keeps an already resolved workspace and domain', () => {
    const cloudProject = {
      ...project,
      project_store: 'cloud',
      workspace_id: 'project-workspace',
    } as CollaborationProject

    expect(
      standInReturnLocation(cloudProject, {
        ...returnLocation,
        collaborationDomain: 'cloud',
        workspaceId: 'return-workspace',
      })
    ).toMatchObject({
      collaborationDomain: 'cloud',
      workspaceId: 'return-workspace',
    })
  })
})
