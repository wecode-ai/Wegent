// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceBoardSnapshot } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'
import {
  collaborationWorkspaceControllerReducer,
  createCollaborationWorkspaceControllerCommands,
  initialCollaborationWorkspaceControllerState,
  type CollaborationWorkspaceControllerState,
} from './useCollaborationWorkspaceController'

const project: CollaborationProject = {
  id: 'project-1',
  public_id: 'public-1',
  project_key: 'PRJ',
  name: 'Project',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
}
const updated: CollaborationProject = {
  ...project,
  version: 2,
  name: 'Updated project',
  tags: ['new phase'],
  board_views: { schema_version: 1, views: [], default_view_id: 'default' },
}
const snapshot: WorkspaceBoardSnapshot = { items: [], members: [], agents: [], taskBindings: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createController() {
  let state: CollaborationWorkspaceControllerState = {
    ...initialCollaborationWorkspaceControllerState,
    projects: [project],
    project,
  }
  const get = vi.fn().mockResolvedValue(updated)
  const list = vi.fn().mockResolvedValue([project])
  const getBoardSnapshot = vi.fn().mockResolvedValue(snapshot)
  const api = {
    projects: { get, list },
    issues: { getBoardSnapshot },
  } as unknown as SharedWorkspaceApi
  const commands = createCollaborationWorkspaceControllerCommands({
    api,
    myWorkEnabled: false,
    messages: { loadFailed: 'Load failed', saveFailed: 'Save failed', conflict: 'Conflict' },
    dispatch: action => {
      state = collaborationWorkspaceControllerReducer(state, action)
    },
    getProjects: () => state.projects,
    getProjectSnapshot: () => snapshot,
    getSelectedIssue: () => null,
    getExternalBoardState: () => state,
    getExternalBoardOptions: () => ({ parentId: null, pageSize: 100, eager: true }),
  })
  return { commands, get, list, getBoardSnapshot, getState: () => state }
}

describe('project metadata revalidation', () => {
  it('shares a same-version initial board read and clears its superseded loading state', async () => {
    const { commands, get, getBoardSnapshot, getState } = createController()
    const pending = deferred<WorkspaceBoardSnapshot>()
    get.mockResolvedValueOnce(project)
    getBoardSnapshot.mockReturnValueOnce(pending.promise)
    const initial = commands.loadProject(project.id)
    expect(getState().loading).toBe(true)
    const validation = commands.loadProject(project.id, false, { revalidate: true })
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
    expect(getBoardSnapshot).toHaveBeenCalledOnce()
    pending.resolve(snapshot)
    await Promise.all([initial, validation])

    expect(getState().project).toEqual(project)
    expect(getState().loading).toBe(false)
  })

  it('reuses a pending home snapshot when initial project metadata has the same version', async () => {
    const { commands, get, getBoardSnapshot } = createController()
    const pending = deferred<WorkspaceBoardSnapshot>()
    get.mockResolvedValueOnce(project)
    getBoardSnapshot.mockReturnValueOnce(pending.promise)
    const home = commands.loadProjects()
    await vi.waitFor(() => expect(getBoardSnapshot).toHaveBeenCalledOnce())

    const validation = commands.loadProject(project.id, false, { revalidate: true })
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
    expect(getBoardSnapshot).toHaveBeenCalledOnce()
    pending.resolve(snapshot)
    await Promise.all([home, validation])
  })

  it('publishes fresh metadata before its board finishes loading', async () => {
    const { commands, get, getBoardSnapshot, getState } = createController()
    const pending = deferred<WorkspaceBoardSnapshot>()
    getBoardSnapshot.mockReturnValueOnce(pending.promise)

    const loading = commands.loadProject(project.id, false, { revalidate: true })
    await vi.waitFor(() => expect(getBoardSnapshot).toHaveBeenCalledOnce())

    expect(get).toHaveBeenCalledWith(project.id)
    expect(getState().project).toEqual(updated)
    expect(getState().projects).toEqual([updated])
    pending.resolve(snapshot)
    await loading
    expect(getState().project).toEqual(updated)
  })

  it('does not let a periodic board refresh supersede an in-flight metadata revalidation', async () => {
    const { commands, get, getState } = createController()
    const pending = deferred<CollaborationProject>()
    get.mockReturnValueOnce(pending.promise)

    const loading = commands.loadProject(project.id, false, { revalidate: true })
    const polling = commands.loadProject(project.id, false)
    pending.resolve(updated)
    await Promise.all([loading, polling])

    expect(getState().project).toEqual(updated)
  })

  it('queues an invalidating board refresh behind metadata revalidation', async () => {
    const { commands, get, getBoardSnapshot, getState } = createController()
    const pending = deferred<CollaborationProject>()
    get.mockReturnValueOnce(pending.promise)
    const loading = commands.loadProject(project.id, false, { revalidate: true })
    const changedBoard = commands.loadProject(project.id, false, { invalidate: true })

    pending.resolve(updated)
    await Promise.all([loading, changedBoard])

    expect(getState().project).toEqual(updated)
    expect(get).toHaveBeenCalledOnce()
    expect(getBoardSnapshot).toHaveBeenCalledTimes(2)
  })

  it('reports metadata failure to the revalidation caller while a periodic refresh is waiting', async () => {
    const { commands, get, getState } = createController()
    const pending = deferred<CollaborationProject>()
    const cause = new Error('Network unavailable')
    get.mockReturnValueOnce(pending.promise)
    const loading = commands.loadProject(project.id, false, {
      revalidate: true,
      throwOnError: true,
    })
    const failed = expect(loading).rejects.toBe(cause)
    const polling = commands.loadProject(project.id, false)

    pending.reject(cause)
    await Promise.all([failed, expect(polling).resolves.toBeUndefined()])

    expect(getState().project).toEqual(project)
    expect(getState().errorSource).toBe('load')
  })

  it('keeps the existing project after failure, rejects for its caller and recovers', async () => {
    const { commands, get, getBoardSnapshot, getState } = createController()
    const cause = new Error('Network unavailable')
    get.mockRejectedValueOnce(cause)

    await expect(
      commands.loadProject(project.id, false, { revalidate: true, throwOnError: true })
    ).rejects.toBe(cause)
    expect(getState().project).toEqual(project)
    expect(getState().errorSource).toBe('load')
    expect(getBoardSnapshot).not.toHaveBeenCalled()

    await commands.loadProject(project.id, false, { revalidate: true, loadSnapshot: false })
    expect(getState().project).toEqual(updated)
    expect(getState().error).toBeNull()
  })

  it('invalidates a pre-revalidation board read and retains the fresh project', async () => {
    const { commands, getBoardSnapshot, getState } = createController()
    const pending = deferred<WorkspaceBoardSnapshot>()
    getBoardSnapshot.mockReturnValueOnce(pending.promise)
    const oldRead = commands.loadProjectSnapshot(project.id)

    await commands.loadProject(project.id, false, { revalidate: true })
    pending.resolve(snapshot)

    await expect(oldRead).resolves.toBeNull()
    expect(getState().project).toEqual(updated)
    expect(getBoardSnapshot).toHaveBeenCalledTimes(2)
  })

  it('keeps a successful mutation when an older catalog request completes later', async () => {
    const { commands, list, getState } = createController()
    const pending = deferred<CollaborationProject[]>()
    list.mockReturnValueOnce(pending.promise)
    const loading = commands.loadProjectCatalog()

    commands.replaceProject(updated)
    pending.resolve([project])
    await loading
    await commands.loadProject(project.id, false, { loadSnapshot: false })

    expect(getState().project).toEqual(updated)
    expect(getState().projects).toEqual([updated])
    commands.replaceProject(project)
    expect(getState().project).toEqual(updated)
  })

  it('invalidates pending board data when a catalog discovers a new project version', async () => {
    const { commands, list, getBoardSnapshot, getState } = createController()
    const pending = deferred<WorkspaceBoardSnapshot>()
    getBoardSnapshot.mockReturnValueOnce(pending.promise)
    const loading = commands.loadProjectSnapshot(project.id)
    list.mockResolvedValueOnce([updated])

    await commands.loadProjectCatalog()
    pending.resolve(snapshot)

    await expect(loading).resolves.toBeNull()
    expect(getState().projects).toEqual([updated])
  })

  it('ignores a metadata response superseded by a mutation without reporting failure', async () => {
    const { commands, get, getBoardSnapshot, getState } = createController()
    const pending = deferred<CollaborationProject>()
    get.mockReturnValueOnce(pending.promise)
    const loading = commands.loadProject(project.id, false, {
      revalidate: true,
      throwOnError: true,
    })

    commands.replaceProject(updated)
    pending.resolve(project)
    await expect(loading).resolves.toBeUndefined()

    expect(getState().project).toEqual(updated)
    expect(getBoardSnapshot).not.toHaveBeenCalled()
    expect(getState().error).toBeNull()
  })

  it('rejects older project and board actions in the reducer', () => {
    const state = {
      ...initialCollaborationWorkspaceControllerState,
      projects: [updated],
      project: updated,
    }
    expect(
      collaborationWorkspaceControllerReducer(state, {
        type: 'project-loaded',
        project,
        snapshot,
      })
    ).toBe(state)
    expect(
      collaborationWorkspaceControllerReducer(state, {
        type: 'project-catalog-loaded',
        projects: [project],
      }).projects
    ).toEqual([updated])
  })
})
