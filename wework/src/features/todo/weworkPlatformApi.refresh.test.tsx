import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  CollaborationOwnedAgent,
  CollaborationPlatformLocation,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import { useCollaborationPlatformController } from '@wegent/collaboration/platform'
import { createWeworkPlatformApi } from './weworkPlatformApi'
import { LOCAL_WORKSPACE_ID } from './localWorkspaceApi'

const location: CollaborationPlatformLocation = {
  platformView: 'spaces',
  rootView: 'agents',
  workspaceId: null,
  workspaceView: 'home',
  projectId: null,
  projectView: 'board',
  issueId: null,
}

function resource(id: string): CollaborationOwnedAgent {
  return {
    id,
    name: id,
    team_id: Number(id),
    owner_id: '1',
    owner_name: 'Owner',
    owner_type: 'user',
    status: 'available',
    execution_environment_ids: [],
  }
}

function source(agents: CollaborationOwnedAgent[], local = false) {
  return {
    projects: { list: vi.fn(async () => []) },
    workspaces: {
      get: vi.fn(async () => ({ id: LOCAL_WORKSPACE_ID, location: 'local' })),
      list: vi.fn(async () => []),
    },
    resources: {
      list: vi.fn(async () => ({ agents, execution_environments: [] })),
      removeAgent: vi.fn(async (agent: CollaborationOwnedAgent) => {
        agents.splice(
          agents.findIndex(item => item.id === agent.id),
          1
        )
      }),
    },
    ...(local ? {} : { issues: {} }),
  } as unknown as SharedWorkspaceApi
}

afterEach(cleanup)

it.each(['before', 'after'] as const)(
  'reports a cloud refresh failure through the desktop adapter %s navigation settles and recovers',
  async timing => {
    const local = source([resource('local-agent')], true)
    const cloud = source([resource('1'), resource('2')])
    const api = createWeworkPlatformApi(cloud, local)!
    const { result } = renderHook(() =>
      useCollaborationPlatformController({ api, location, loadFailedMessage: 'Load failed' })
    )
    await waitFor(() => expect(result.current.state.resources.agents).toHaveLength(3))
    const deleted = result.current.state.resources.agents.find(agent => agent.id === '1')!
    await api.resources!.removeAgent!(deleted)
    expect(cloud.resources!.removeAgent).toHaveBeenCalledExactlyOnceWith(deleted)
    expect(local.resources!.removeAgent).not.toHaveBeenCalled()

    let rejectRefresh!: (error: Error) => void
    let resolveProjects!: (value: never[]) => void
    vi.mocked(cloud.resources!.list).mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectRefresh = reject
      })
    )
    vi.mocked(cloud.projects.list).mockReturnValueOnce(
      new Promise(resolve => {
        resolveProjects = resolve
      })
    )
    let reload!: Promise<void>
    act(() => {
      reload = result.current.commands.reload()
    })
    if (timing === 'before') {
      await act(async () => rejectRefresh(new Error('Offline')))
    }
    await act(async () => {
      resolveProjects([])
      await reload
    })
    if (timing === 'after') {
      await act(async () => rejectRefresh(new Error('Offline')))
    }
    await waitFor(() => expect(result.current.state.resourceLoadFailed).toBe(true))
    expect(result.current.state.error).toBeNull()
    expect(result.current.state.resources.agents.map(agent => agent.id)).toEqual(['local-agent'])

    await act(async () => result.current.commands.reload())
    await waitFor(() =>
      expect(result.current.state.resources.agents.map(agent => agent.id)).toEqual([
        'local-agent',
        '2',
      ])
    )
    expect(result.current.state.error).toBeNull()
    expect(result.current.state.resourceLoadFailed).toBe(false)
  }
)
