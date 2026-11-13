import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient } from '@wegent/chat-core'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { User } from '@/types/api'
import {
  experienceIssueFixture,
  experienceMessageFixture,
  experienceProjectFixture,
} from '../model/fixtures'
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
  const myWorkPage = vi.fn().mockResolvedValue({ items: [], nextCursor: null })
  const api = {
    projects: {
      list: vi.fn(),
      get: vi.fn().mockResolvedValue(experienceProjectFixture({ id: projectId })),
    },
    issues: { get: getIssue },
    comments: { create, list },
    myWork: { list: vi.fn(), page: myWorkPage },
  } as unknown as SharedWorkspaceApi
  return { api, create, list, getIssue, myWorkPage }
}

const user = { id: 7, user_name: 'Member', email: '' } as User
const localParticipationIdentity = {
  nativeOwnerUserId: 0 as const,
  currentUser: user,
  viewerUserIds: [0, 7],
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
      localParticipationIdentity,
      sharedWorkspaceApi: cloud.api,
      projectSpaceDetailServices: {
        local: { projectChatClient: localClient },
        cloud: { projectChatClient: cloudClient },
      },
    } as unknown as WorkbenchServices
    const { result } = renderHook(() => useExperienceSources(services, user, true, 'en'))
    expect(result.current.map(source => source.store)).toEqual(['local', 'backend'])
    expect(result.current[0].api.activity).toBe(localClient)
    expect(result.current[1].api.activity).toBe(cloudClient)
    expect(result.current.map(source => source.participationViewer)).toEqual([[0, 7], 7])
    expect(mocks.createLocal).toHaveBeenCalledWith(
      undefined,
      7,
      'Member',
      '',
      services.projectSpaceDetailServices!.local,
      'en'
    )
    expect((await result.current[0].api.projects.get('local-project')).current_user_id).toBe(7)
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

  it.each([true, false])(
    'keeps local My work readers source scoped with cloud connected=%s',
    async connected => {
      const local = apiFixture('local-project')
      const cloud = apiFixture('cloud-project')
      mocks.createLocal.mockReturnValue(local.api)
      const services = {
        localParticipationIdentity,
        sharedWorkspaceApi: cloud.api,
      } as unknown as WorkbenchServices
      const { result } = renderHook(() => useExperienceSources(services, user, connected, 'en'))
      const pageInput = {
        cursor: 'next-page',
        limit: 30,
        scope: 'participating' as const,
        includeCompleted: true,
        order: 'attention' as const,
        viewerIds: [7],
      }
      const localSource = result.current.find(source => source.store === 'local')!
      expect(localSource.participationViewer).toBe(localParticipationIdentity.viewerUserIds)
      await localSource.api.myWork!.page!({ ...pageInput, viewerIds: [999] })
      expect(local.myWorkPage).toHaveBeenCalledExactlyOnceWith({
        ...pageInput,
        viewerIds: [0, 7],
      })
      const cloudSource = result.current.find(source => source.store === 'backend')
      if (connected) {
        expect(cloudSource!.participationViewer).toBe(7)
        await cloudSource!.api.myWork!.page!(pageInput)
        expect(cloud.myWorkPage).toHaveBeenCalledExactlyOnceWith(pageInput)
      } else {
        expect(cloudSource).toBeUndefined()
        expect(cloud.myWorkPage).not.toHaveBeenCalled()
      }
    }
  )

  it('preserves unknown local readers without inventing native identity or blocking cloud reads', async () => {
    const local = apiFixture('local-project')
    const cloud = apiFixture('cloud-project')
    mocks.createLocal.mockReturnValue(local.api)
    const services = { sharedWorkspaceApi: cloud.api } as unknown as WorkbenchServices
    const { result } = renderHook(() => useExperienceSources(services, user, true, 'en'))
    expect(result.current[0].participationViewer).toEqual([])
    await expect(result.current[0].api.myWork!.page!({ viewerIds: [7] })).rejects.toThrow(
      'Local participation identity is unavailable'
    )
    expect(local.myWorkPage).not.toHaveBeenCalled()
    await result.current[1].api.myWork!.page!({ viewerIds: [7] })
    expect(cloud.myWorkPage).toHaveBeenCalledExactlyOnceWith({ viewerIds: [7] })
    expect(result.current[0].api.projects.get).toBe(local.api.projects.get)
  })

  it('replaces local profile readers when the owning services and account change', async () => {
    const local = apiFixture('local-project')
    mocks.createLocal.mockReturnValue(local.api)
    const services = { localParticipationIdentity } as unknown as WorkbenchServices
    const { result, rerender } = renderHook(
      ({ services, user }) => useExperienceSources(services, user, false, 'en'),
      { initialProps: { services, user } }
    )
    const previousSource = result.current[0]
    const nextUser = { ...user, id: 8 }
    rerender({
      services: {
        localParticipationIdentity: {
          nativeOwnerUserId: 0,
          currentUser: nextUser,
          viewerUserIds: [0, 8],
        },
      } as unknown as WorkbenchServices,
      user: nextUser,
    })
    expect(result.current[0]).not.toBe(previousSource)
    expect(result.current[0].participationViewer).toEqual([0, 8])
    await result.current[0].api.myWork!.page!({ viewerIds: [7] })
    expect(local.myWorkPage).toHaveBeenCalledExactlyOnceWith({ viewerIds: [0, 8] })
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
