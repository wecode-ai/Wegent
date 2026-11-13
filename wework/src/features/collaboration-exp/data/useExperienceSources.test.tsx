import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient } from '@wegent/chat-core'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { User } from '@/types/api'
import { experienceIssueFixture, experienceMessageFixture } from '../model/fixtures'
import { useExperienceSources } from './useExperienceSources'
import { withExperienceProjectChat } from './withExperienceProjectChat'

const mocks = vi.hoisted(() => ({ createLocal: vi.fn() }))
vi.mock('@/features/todo/localWorkspaceApi', () => ({
  createLocalWorkspaceApi: mocks.createLocal,
  LOCAL_WORKSPACE_ID: 'wework-local-workspace',
}))

function apiFixture(projectId: string) {
  const create = vi.fn()
  const list = vi.fn()
  const getIssue = vi
    .fn()
    .mockResolvedValue(experienceIssueFixture({ cloud_project_id: projectId }))
  const api = {
    projects: { list: vi.fn() },
    issues: { get: getIssue },
    comments: { create, list },
  } as unknown as SharedWorkspaceApi
  return { api, create, list, getIssue }
}

beforeEach(() => vi.clearAllMocks())

describe('experience canonical source composition', () => {
  it('uses the exact local and cloud clients even when both stores have the same Issue id', async () => {
    const local = apiFixture('local-project')
    const cloud = apiFixture('cloud-project')
    const localSend = vi
      .fn()
      .mockResolvedValue(experienceMessageFixture({ projectId: 'local-project' }))
    const cloudSend = vi
      .fn()
      .mockResolvedValue(experienceMessageFixture({ projectId: 'cloud-project' }))
    const localClient = { send: localSend } as unknown as ProjectChatClient
    const cloudClient = { send: cloudSend } as unknown as ProjectChatClient
    mocks.createLocal.mockReturnValue(local.api)
    const services = {
      sharedWorkspaceApi: cloud.api,
      projectSpaceDetailServices: {
        local: { projectChatClient: localClient },
        cloud: { projectChatClient: cloudClient },
      },
    } as unknown as WorkbenchServices
    const user = { id: 7, user_name: 'Member', email: '' } as User
    const { result } = renderHook(() => useExperienceSources(services, user, true, 'en'))
    expect(result.current.map(source => source.store)).toEqual(['local', 'backend'])
    expect(result.current[0].api.activity).toBe(localClient)
    expect(result.current[1].api.activity).toBe(cloudClient)
    await result.current[0].api.comments.create('EXP-1', 'Local conclusion')
    await result.current[1].api.comments.create('EXP-1', 'Cloud conclusion')
    expect(localSend).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'local-project',
        taskId: 'EXP-1',
        text: 'Local conclusion',
      })
    )
    expect(cloudSend).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'cloud-project',
        taskId: 'EXP-1',
        text: 'Cloud conclusion',
      })
    )
    expect(local.create).not.toHaveBeenCalled()
    expect(cloud.create).not.toHaveBeenCalled()
  })

  it('does not expose a cloud source while disconnected or reuse the cloud client for local activity', () => {
    const local = apiFixture('local-project')
    mocks.createLocal.mockReturnValue(local.api)
    const services = {
      sharedWorkspaceApi: apiFixture('cloud-project').api,
      projectSpaceDetailServices: { cloud: { projectChatClient: {} } },
    } as unknown as WorkbenchServices
    const user = { id: 7, user_name: 'Member', email: '' } as User
    const { result } = renderHook(() => useExperienceSources(services, user, false, 'en'))
    expect(result.current.map(source => source.store)).toEqual(['local'])
    expect(result.current[0].api.activity).toBeUndefined()
  })

  it('rejects unavailable or failed canonical operations without writing invisible REST comments', async () => {
    const source = apiFixture('project-1')
    const missing = withExperienceProjectChat(source.api, undefined)
    await expect(missing.comments.create('EXP-1', 'Retain this draft')).rejects.toThrow(
      'Project activity service is unavailable'
    )
    await expect(missing.comments.list('EXP-1')).rejects.toThrow(
      'Project activity service is unavailable'
    )
    const send = vi.fn().mockRejectedValue(new Error('Canonical stream offline'))
    const broken = withExperienceProjectChat(source.api, { send } as unknown as ProjectChatClient)
    await expect(broken.comments.create('EXP-1', 'Retain this draft')).rejects.toThrow(
      'Canonical stream offline'
    )
    expect(source.create).not.toHaveBeenCalled()
    expect(source.list).not.toHaveBeenCalled()
  })
})
