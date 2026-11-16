import { describe, expect, it, vi, afterEach } from 'vitest'
import type {
  CollaborationMember,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import {
  ProjectCreateMembersError,
  type ProjectCreateResourceSelection,
} from '@wegent/collaboration/project-create'
import { createProjectResourceSetup } from './createProjectResourceSetup'

const owner = { id: 1, user_id: 1, user_name: 'owner', email: null, role: 'Owner' as const }
const selection: ProjectCreateResourceSelection = {
  memberUserIds: [1, 2, 2, 3],
  agentResourceIds: [],
  executionEnvironmentDeviceIds: [],
  collaborationGroupDrafts: [],
}

afterEach(() => vi.unstubAllEnvs())

describe('ordinary project resource setup', () => {
  it('verifies persisted members and refreshes the project before completing', async () => {
    const members: CollaborationMember[] = [owner]
    const api = {
      members: {
        list: vi.fn(async () => [...members]),
        searchUsers: vi.fn(async () => []),
        add: vi.fn(
          async (_projectId: string, userId: number, role: CollaborationMember['role']) => {
            const member = { ...owner, id: userId, user_id: userId, role }
            members.push(member)
            return member
          }
        ),
      },
    } as unknown as SharedWorkspaceApi
    const refresh = vi.fn(async () => {
      expect(api.members.list).toHaveBeenCalledTimes(2)
      expect(members.map(member => member.user_id)).toEqual([1, 2, 3])
    })
    const setup = createProjectResourceSetup(api, { id: 1, name: 'owner' }, refresh, 'Retry')!
    await setup.configure({ id: 'new-project' } as CollaborationProject, selection)

    expect(api.members.add).toHaveBeenCalledTimes(2)
    expect(api.members.add).toHaveBeenCalledWith('new-project', 2, 'Developer')
    expect(api.members.add).toHaveBeenCalledWith('new-project', 3, 'Developer')
    expect(refresh).toHaveBeenCalledWith('new-project', members.slice(1))
  })

  it('uses the shared user search without an app-specific directory', async () => {
    const searchUsers = vi.fn(async () => [{ id: 2, user_name: 'alice', email: null }])
    const api = { members: { searchUsers } } as unknown as SharedWorkspaceApi
    const setup = createProjectResourceSetup(api, { id: 1, name: 'owner' }, vi.fn(), 'Retry')!
    expect(await setup.searchUsers!('alice')).toEqual([{ id: 2, user_name: 'alice', email: null }])
    expect(searchUsers).toHaveBeenCalledWith('alice')
  })

  it('supports rolling back collab.projectCreateMembers.v1', () => {
    vi.stubEnv('VITE_COLLAB_PROJECT_CREATE_MEMBERS_V1', 'false')
    expect(
      createProjectResourceSetup({} as SharedWorkspaceApi, { id: 1, name: 'owner' }, vi.fn(), '')
    ).toBeUndefined()
    expect(
      createProjectResourceSetup(undefined, { id: 1, name: 'owner' }, vi.fn(), '')
    ).toBeUndefined()
  })

  it('keeps a failed project refresh retryable without reporting saved members as failed', async () => {
    const members: CollaborationMember[] = [
      owner,
      { ...owner, id: 2, user_id: 2, user_name: 'alice', role: 'Developer' },
    ]
    const add = vi.fn()
    const api = {
      members: { list: vi.fn(async () => members), add },
    } as unknown as SharedWorkspaceApi
    let refreshFailed = true
    const refresh = vi.fn(async () => {
      if (refreshFailed) throw new Error('Project refresh failed')
    })
    const setup = createProjectResourceSetup(api, { id: 1, name: 'owner' }, refresh, 'Retry')!
    const selected = { ...selection, memberUserIds: [2] }

    const error = await setup
      .configure({ id: 'new-project' } as CollaborationProject, selected)
      .catch(cause => cause)

    expect(error).toBeInstanceOf(ProjectCreateMembersError)
    expect(error.message).toBe('Project refresh failed')
    expect(error.failures).toEqual([])
    expect(error.members).toEqual(members)
    refreshFailed = false
    await setup.configure({ id: 'new-project' } as CollaborationProject, selected)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(add).not.toHaveBeenCalled()
  })
})
