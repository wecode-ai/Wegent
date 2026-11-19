// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue, CollaborationLocation, CollaborationProject } from '../types'

type Subscription = () => () => void

const hookRuntime = vi.hoisted(() => {
  let hookIndex = 0
  let hooks: Array<Record<string, unknown>> = []
  let pendingSubscriptions: Array<{ subscribe: Subscription; index: number }> = []
  return {
    reset() {
      for (const hook of hooks) {
        if (typeof hook.cleanup === 'function') hook.cleanup()
      }
      hooks = []
      pendingSubscriptions = []
      hookIndex = 0
    },
    beginRender() {
      hookIndex = 0
      pendingSubscriptions = []
    },
    flushEffects() {
      for (const { subscribe, index } of pendingSubscriptions) {
        const hook = hooks[index]
        if (typeof hook.cleanup === 'function') hook.cleanup()
        hook.cleanup = subscribe()
      }
      pendingSubscriptions = []
    },
    useState<T>(initialValue: T | (() => T)): [T, (value: T) => void] {
      const index = hookIndex++
      const hook = hooks[index] ?? {
        value: typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue,
      }
      hooks[index] = hook
      if (!hook.setValue)
        hook.setValue = (value: T) => {
          hook.value = value
        }
      return [hook.value as T, hook.setValue as (value: T) => void]
    },
    useSyncExternalStore<T>(
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => T
    ): T {
      const index = hookIndex++
      const hook = hooks[index] ?? {}
      hooks[index] = hook
      pendingSubscriptions.push({ subscribe: () => subscribe(() => undefined), index })
      return getSnapshot()
    },
  }
})

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: hookRuntime.useState,
    useSyncExternalStore: hookRuntime.useSyncExternalStore,
  }
})

import {
  type CollaborationWorkspaceController,
  initialCollaborationWorkspaceControllerState,
  useCollaborationWorkspaceController,
} from './useCollaborationWorkspaceController'

const projectA: CollaborationProject = {
  id: 'project-a',
  public_id: 'public-a',
  project_key: 'A',
  name: 'Project A',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-09-10T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
}

const projectB: CollaborationProject = {
  ...projectA,
  id: 'project-b',
  public_id: 'public-b',
  project_key: 'B',
  name: 'Project B',
}

function createIssue(id: string, project: CollaborationProject): CollaborationIssue {
  return {
    id,
    cloud_project_id: project.id,
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: id,
    description: '',
    status: 'pending',
    priority: 'none',
    due_at: null,
    tags: [],
    sort_order: 0,
    version: 1,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    completed_at: null,
  }
}

const issueA = createIssue('issue-a', projectA)
const issueB = createIssue('issue-b', projectB)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createApi(): SharedWorkspaceApi {
  return {
    projects: {
      list: vi.fn().mockResolvedValue([projectA, projectB]),
      get: vi.fn(async (projectId: string) => (projectId === projectA.id ? projectA : projectB)),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    },
    issues: {
      getBoardSnapshot: vi.fn(async (projectId: string) => ({
        items: [projectId === projectA.id ? issueA : issueB],
        members: [],
        agents: [],
        taskBindings: [],
      })),
      get: vi.fn(async (issueId: string) => (issueId === issueA.id ? issueA : issueB)),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      reorder: vi.fn(),
    },
    attachments: {
      list: vi.fn().mockResolvedValue([]),
    },
    comments: {
      list: vi.fn().mockResolvedValue([]),
    },
  } as unknown as SharedWorkspaceApi
}

const messages = {
  loadFailed: 'load failed',
  saveFailed: 'save failed',
  conflict: 'conflict',
}

function RenderControllerFixture(
  api: SharedWorkspaceApi | null | undefined,
  location: CollaborationLocation,
  myWorkEnabled?: boolean,
  initialProject?: CollaborationProject,
  loadProjectOnLocation = true
): CollaborationWorkspaceController {
  hookRuntime.beginRender()
  const controller = useCollaborationWorkspaceController({
    api,
    location,
    messages,
    initialProject,
    loadProjectOnLocation,
    ...(myWorkEnabled === undefined ? {} : { myWorkEnabled }),
    pollIntervalMs: 0,
  })
  hookRuntime.flushEffects()
  return controller
}

describe('useCollaborationWorkspaceController location effects', () => {
  beforeEach(() => {
    hookRuntime.reset()
  })

  it('keeps the project mounted when opening and closing an Issue', async () => {
    const api = createApi()
    const location = {
      projectId: projectA.id,
      issueId: null as string | null,
      view: 'board' as const,
    }
    RenderControllerFixture(api, location)
    await vi.waitFor(() =>
      expect(RenderControllerFixture(api, location).state.project?.id).toBe(projectA.id)
    )
    const reads = vi.mocked(api.issues.getBoardSnapshot).mock.calls.length
    const opened = { ...location, issueId: issueA.id }
    RenderControllerFixture(api, opened)
    await vi.waitFor(() =>
      expect(RenderControllerFixture(api, opened).state.selectedIssue?.id).toBe(issueA.id)
    )
    expect(RenderControllerFixture(api, opened).state.loading).toBe(false)
    RenderControllerFixture(api, location)
    await vi.waitFor(() =>
      expect(RenderControllerFixture(api, location).state.selectedIssue).toBeNull()
    )
    expect(RenderControllerFixture(api, location).state.loading).toBe(false)
    expect(api.issues.getBoardSnapshot).toHaveBeenCalledTimes(reads)
  })

  it('keeps a loaded Issue mounted while its API refreshes the current project', async () => {
    const api = createApi()
    const location: CollaborationLocation = {
      projectId: projectA.id,
      issueId: issueA.id,
      view: 'board',
    }
    await vi.waitFor(() => {
      const controller = RenderControllerFixture(api, location)
      expect(controller.state.project?.id).toBe(projectA.id)
      expect(controller.state.selectedIssue?.id).toBe(issueA.id)
      expect(controller.state.loading).toBe(false)
    })
    const snapshot = await api.issues.getBoardSnapshot(projectA.id)
    const refresh = deferred<typeof snapshot>()
    const refreshedApi = api
    vi.mocked(refreshedApi.issues.getBoardSnapshot)
      .mockReset()
      .mockImplementation(() => refresh.promise)
    const closedLocation = { ...location, issueId: null }

    let refreshing: Promise<void> | undefined
    try {
      refreshing = RenderControllerFixture(refreshedApi, location).commands.loadProject(projectA.id)
      await vi.waitFor(() => {
        RenderControllerFixture(refreshedApi, location)
        expect(refreshedApi.issues.getBoardSnapshot).toHaveBeenCalled()
      })
      const controller = RenderControllerFixture(refreshedApi, location)
      // A loading screen would unmount the drawer and cancel its pending close.
      expect(controller.state.loading).toBe(false)
      expect(controller.state.selectedIssue?.id).toBe(issueA.id)
      expect(RenderControllerFixture(refreshedApi, closedLocation).state.selectedIssue).toBeNull()
    } finally {
      refresh.resolve(snapshot)
      await refreshing
    }
    await vi.waitFor(() => {
      const controller = RenderControllerFixture(refreshedApi, closedLocation)
      expect(controller.state.loading).toBe(false)
      expect(controller.state.selectedIssue).toBeNull()
    })
  })

  it('loads an invited Issue without requesting project authority', async () => {
    const api = createApi()
    const invited = { ...issueA, invited_only: true, can_edit: true }
    api.issues.get = vi.fn().mockResolvedValue(invited)
    const location = {
      projectId: projectA.id,
      issueId: issueA.id,
      view: 'board' as const,
    }
    RenderControllerFixture(api, location)
    await vi.waitFor(() => expect(RenderControllerFixture(api, location).state.loading).toBe(false))
    expect(RenderControllerFixture(api, location).state.selectedIssue).toEqual(invited)
    expect(api.projects.get).not.toHaveBeenCalled()
    expect(api.projects.list).not.toHaveBeenCalled()
    expect(api.issues.getBoardSnapshot).not.toHaveBeenCalled()
    expect(RenderControllerFixture(api, location).state.error).toBeNull()
  })

  it('keeps a host-managed project catalog loaded when switching between board and settings', async () => {
    const api = createApi()
    const location = {
      projectId: projectA.id,
      issueId: null,
      view: 'board' as const,
    }
    const render = (view: 'board' | 'manage') =>
      RenderControllerFixture(api, { ...location, view }, false, undefined, false)
    render('board')
    await vi.waitFor(() => expect(render('board').state.loading).toBe(false))
    expect(api.projects.list).toHaveBeenCalledOnce()

    expect(render('manage').state.loading).toBe(false)
    expect(render('board').state.loading).toBe(false)
    expect(api.projects.list).toHaveBeenCalledOnce()
    expect(api.issues.getBoardSnapshot).not.toHaveBeenCalled()
  })

  it('opens settings from project metadata and loads the board only on returning to it', async () => {
    const api = createApi()
    const location = {
      projectId: projectA.id,
      issueId: null,
      view: 'manage' as const,
    }
    RenderControllerFixture(api, location)
    await vi.waitFor(() =>
      expect(RenderControllerFixture(api, location).state.project?.id).toBe(projectA.id)
    )
    expect(api.issues.getBoardSnapshot).not.toHaveBeenCalled()
    RenderControllerFixture(api, { ...location, view: 'board' })
    await vi.waitFor(() => expect(api.issues.getBoardSnapshot).toHaveBeenCalledWith(projectA.id))
  })

  it('retains the directly opened Issue when settings metadata arrives later', async () => {
    const api = createApi()
    let resolveProject!: (project: CollaborationProject) => void
    api.projects.get = vi.fn(
      () =>
        new Promise(resolve => {
          resolveProject = resolve
        })
    )
    const location = {
      projectId: projectA.id,
      issueId: issueA.id,
      view: 'manage' as const,
    }
    RenderControllerFixture(api, location)
    await vi.waitFor(() =>
      expect(RenderControllerFixture(api, location).state.selectedIssue?.id).toBe(issueA.id)
    )
    resolveProject(projectA)
    await vi.waitFor(() =>
      expect(RenderControllerFixture(api, location).state.project?.id).toBe(projectA.id)
    )
    expect(RenderControllerFixture(api, location).state.selectedIssue?.id).toBe(issueA.id)
  })

  it('defaults My Work closed and falls an old root location back to home', async () => {
    const api = createApi()

    RenderControllerFixture(api, {
      projectId: null,
      issueId: null,
      view: 'board',
      rootView: 'my-work',
    })

    await vi.waitFor(() => {
      expect(api.projects.list).toHaveBeenCalledOnce()
    })
    expect(api.myWork).toBeUndefined()
  })

  it('does not wait for the catalog when opening an already loaded project', async () => {
    const api = createApi()
    const location = {
      projectId: projectA.id,
      issueId: null,
      view: 'board' as const,
    }
    RenderControllerFixture(api, location, false, projectA)
    await vi.waitFor(() => {
      const controller = RenderControllerFixture(api, location, false, projectA)
      expect(controller.state.project).toEqual(projectA)
      expect(controller.state.loading).toBe(false)
    })
    expect(api.projects.list).not.toHaveBeenCalled()
    expect(api.projects.get).not.toHaveBeenCalled()
    expect(api.issues.getBoardSnapshot).toHaveBeenCalledExactlyOnceWith(projectA.id)
  })

  it('keeps the authorized initial project after the API scope resets', async () => {
    const firstApi = createApi()
    const nextApi = createApi()
    const location = {
      projectId: projectA.id,
      issueId: null,
      view: 'board' as const,
    }

    RenderControllerFixture(firstApi, location, false, projectA)
    const controller = RenderControllerFixture(nextApi, location, false, projectA)

    expect(controller.state.projects).toEqual([projectA])
    await vi.waitFor(() =>
      expect(nextApi.issues.getBoardSnapshot).toHaveBeenCalledWith(projectA.id)
    )
    expect(nextApi.projects.list).not.toHaveBeenCalled()
    expect(nextApi.projects.get).not.toHaveBeenCalled()
  })

  it('does not return to project A when its detail resolves after navigation to B', async () => {
    const detailA = deferred<CollaborationProject>()
    const detailB = deferred<CollaborationProject>()
    const api = createApi()
    vi.mocked(api.projects.get)
      .mockImplementationOnce(() => detailA.promise)
      .mockImplementationOnce(() => detailB.promise)

    RenderControllerFixture(api, {
      projectId: projectA.id,
      issueId: null,
      view: 'board',
    })
    RenderControllerFixture(api, {
      projectId: projectB.id,
      issueId: null,
      view: 'board',
    })

    detailB.resolve(projectB)
    await vi.waitFor(() => {
      expect(api.issues.getBoardSnapshot).toHaveBeenCalledWith(projectB.id)
    })

    detailA.resolve(projectA)
    await Promise.resolve()
    await Promise.resolve()

    const controller = RenderControllerFixture(api, {
      projectId: projectB.id,
      issueId: null,
      view: 'board',
    })
    expect(api.issues.getBoardSnapshot).not.toHaveBeenCalledWith(projectA.id)
    expect(controller.state.project).toEqual(projectB)
    expect(controller.state.issues).toEqual([issueB])
  })

  it('clears the old issue immediately and rejects its response after switching issue IDs', async () => {
    const issueBResponse = deferred<CollaborationIssue>()
    const api = createApi()
    vi.mocked(api.issues.get).mockImplementation((issueId: string) =>
      issueId === issueB.id ? issueBResponse.promise : Promise.resolve(issueA)
    )

    RenderControllerFixture(api, {
      projectId: null,
      issueId: issueA.id,
      view: 'board',
    })
    await vi.waitFor(() => {
      const controller = RenderControllerFixture(api, {
        projectId: null,
        issueId: issueA.id,
        view: 'board',
      })
      expect(controller.state.selectedIssue).toEqual(issueA)
    })
    let controller = RenderControllerFixture(api, {
      projectId: null,
      issueId: issueA.id,
      view: 'board',
    })
    expect(controller.state.selectedIssue).toEqual(issueA)

    controller = RenderControllerFixture(api, {
      projectId: null,
      issueId: issueB.id,
      view: 'board',
    })
    expect(controller.state.selectedIssue).toBeNull()
    expect(controller.state.attachments).toEqual([])
    expect(controller.state.comments).toEqual([])

    RenderControllerFixture(api, {
      projectId: null,
      issueId: issueA.id,
      view: 'board',
    })
    issueBResponse.resolve(issueB)
    await vi.waitFor(() => {
      controller = RenderControllerFixture(api, {
        projectId: null,
        issueId: issueA.id,
        view: 'board',
      })
      expect(controller.state.selectedIssue).toEqual(issueA)
    })
  })

  it('ignores an old board response after switching project API sources', async () => {
    const localApi = createApi()
    const cloudApi = createApi()
    const oldSnapshot =
      deferred<Awaited<ReturnType<SharedWorkspaceApi['issues']['getBoardSnapshot']>>>()
    vi.mocked(localApi.issues.getBoardSnapshot).mockReturnValue(oldSnapshot.promise)
    RenderControllerFixture(localApi, {
      projectId: projectA.id,
      issueId: null,
      view: 'board',
    })
    await vi.waitFor(() => expect(localApi.issues.getBoardSnapshot).toHaveBeenCalledOnce())

    const location = {
      projectId: projectB.id,
      issueId: null,
      view: 'board' as const,
    }
    RenderControllerFixture(cloudApi, location)
    await vi.waitFor(() => {
      expect(RenderControllerFixture(cloudApi, location).state.project).toEqual(projectB)
    })
    oldSnapshot.resolve({
      items: [issueA],
      members: [],
      agents: [],
      taskBindings: [],
    })
    await oldSnapshot.promise
    await Promise.resolve()
    const controller = RenderControllerFixture(cloudApi, location)
    expect(controller.state.project).toEqual(projectB)
    expect(controller.state.issues).toEqual([issueB])
  })

  it.each([undefined, null, 'direct'] as const)(
    'does not carry confirmed reads to another API via %s',
    async disconnectedApi => {
      const accountA = createApi()
      const accountB = createApi()
      const unread = {
        ...issueA,
        content_revision: 3,
        activity_read_sequence: 0,
        is_unread: true,
      }
      const read = {
        ...unread,
        activity_read_sequence: 10,
        is_unread: false,
      }
      for (const api of [accountA, accountB]) {
        vi.mocked(api.issues.getBoardSnapshot).mockResolvedValue({
          items: [unread],
          members: [],
          agents: [],
          taskBindings: [],
        })
      }
      accountA.issues.markRead = vi.fn().mockResolvedValue(read)
      const location = {
        projectId: projectA.id,
        issueId: null,
        view: 'board' as const,
      }

      RenderControllerFixture(accountA, location)
      await vi.waitFor(() => {
        expect(RenderControllerFixture(accountA, location).state.issues).toEqual([unread])
      })
      await RenderControllerFixture(accountA, location).commands.markIssueRead(unread)
      expect(RenderControllerFixture(accountA, location).state.issues).toEqual([read])

      if (disconnectedApi !== 'direct') {
        expect(RenderControllerFixture(disconnectedApi, location).state).toEqual(
          initialCollaborationWorkspaceControllerState
        )
      }
      RenderControllerFixture(accountB, location)
      await vi.waitFor(() => {
        expect(accountB.issues.getBoardSnapshot).toHaveBeenCalledOnce()
        expect(RenderControllerFixture(accountB, location).state.issues).toEqual([unread])
      })
      const controller = RenderControllerFixture(accountB, location)
      expect(controller.state.confirmedIssueReads).toEqual({})
    }
  )

  it.each(['another API', 'the same API after reconnect'])(
    'rejects an old pending read after loading the same Issue from %s',
    async destination => {
      const accountA = createApi()
      const accountB = destination === 'another API' ? createApi() : accountA
      const pendingRead = deferred<CollaborationIssue>()
      const unread = {
        ...issueA,
        content_revision: 3,
        activity_read_sequence: 0,
        is_unread: true,
      }
      for (const api of [accountA, accountB]) {
        vi.mocked(api.issues.getBoardSnapshot).mockResolvedValue({
          items: [unread],
          members: [],
          agents: [],
          taskBindings: [],
        })
      }
      accountA.issues.markRead = vi.fn().mockReturnValue(pendingRead.promise)
      const location = {
        projectId: projectA.id,
        issueId: null,
        view: 'board' as const,
      }
      RenderControllerFixture(accountA, location)
      await vi.waitFor(() => {
        expect(RenderControllerFixture(accountA, location).state.issues).toEqual([unread])
      })
      const readRequest = RenderControllerFixture(accountA, location).commands.markIssueRead(unread)

      RenderControllerFixture(undefined, location)
      RenderControllerFixture(accountB, location)
      await vi.waitFor(() => {
        expect(RenderControllerFixture(accountB, location).state.issues).toEqual([unread])
      })
      const beforeRead = RenderControllerFixture(accountB, location).state
      pendingRead.resolve({
        ...unread,
        is_unread: false,
        activity_read_sequence: 10,
      })
      await readRequest

      expect(RenderControllerFixture(accountB, location).state).toEqual(beforeRead)
    }
  )
})
