// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject, CollaborationWorkspace } from '../types'
import type { CollaborationPlatformLocation } from './types'
import {
  useCollaborationPlatformController,
  type CollaborationPlatformState,
} from './useCollaborationPlatformController'

const localWorkspace = {
  id: 'local',
  project_count: 0,
} as CollaborationWorkspace
const cloudWorkspace = {
  id: 'cloud',
  project_count: 1,
} as CollaborationWorkspace
const project = {
  id: 'project',
  workspace_id: 'cloud',
} as CollaborationProject
const location: CollaborationPlatformLocation = {
  platformView: 'spaces',
  workspaceId: 'cloud',
  workspaceView: 'home',
  projectId: project.id,
  projectView: 'board',
  issueId: null,
}
let root: Root | undefined
let container: HTMLDivElement

function currentState(): CollaborationPlatformState {
  return JSON.parse(container.textContent ?? '{}')
}

function apiFor(workspace: CollaborationWorkspace, projects: CollaborationProject[]) {
  return {
    projects: { list: vi.fn(async () => projects) },
    workspaces: { list: vi.fn(async () => [workspace]) },
  } as unknown as SharedWorkspaceApi
}

function Harness(props: {
  api: SharedWorkspaceApi
  navigationApis: SharedWorkspaceApi[]
  location: CollaborationPlatformLocation
  refreshKey?: string
}) {
  const { state } = useCollaborationPlatformController({
    ...props,
    loadFailedMessage: 'Failed',
  })
  return <output>{JSON.stringify(state)}</output>
}

async function render(
  navigationApis: SharedWorkspaceApi[],
  nextLocation = location,
  refreshKey?: string
) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () =>
    root!.render(
      <Harness
        api={navigationApis[0]}
        navigationApis={navigationApis}
        location={nextLocation}
        refreshKey={refreshKey}
      />
    )
  )
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
  vi.unstubAllGlobals()
})

it.each([
  { incomplete: false, projectId: null },
  { incomplete: true, projectId: null },
  { incomplete: false, projectId: project.id },
  { incomplete: true, projectId: project.id },
])(
  'loads a new navigation source with incomplete=$incomplete and project=$projectId',
  async ({ incomplete, projectId }) => {
    const nextLocation = {
      ...location,
      workspaceId: projectId ? 'cloud' : null,
      projectId,
    }
    const cloudApi = apiFor(cloudWorkspace, [project])
    const unavailableLocalApi = apiFor(localWorkspace, [])
    if (incomplete) {
      vi.mocked(unavailableLocalApi.workspaces!.list).mockRejectedValueOnce(
        new Error('Unavailable')
      )
    }
    await render(incomplete ? [cloudApi, unavailableLocalApi] : [cloudApi], nextLocation)
    expect(currentState().navigationIncomplete).toBe(incomplete)

    const localApi = apiFor(localWorkspace, [])
    await render([cloudApi, localApi], nextLocation)

    expect(
      currentState()
        .workspaces.map(workspace => workspace.id)
        .sort()
    ).toEqual(['cloud', 'local'])
    expect(currentState().navigationIncomplete).toBe(false)
    expect(localApi.workspaces!.list).toHaveBeenCalledOnce()
  }
)

it('reuses the cache when the navigation source identities are unchanged', async () => {
  const cloudApi = apiFor(cloudWorkspace, [project])
  await render([cloudApi])
  await render([cloudApi])
  expect(cloudApi.projects.list).toHaveBeenCalledOnce()
  expect(cloudApi.workspaces!.list).toHaveBeenCalledOnce()
})

it('opens a cloud project while the unrelated local navigation is pending', async () => {
  let resolveLocal!: (projects: CollaborationProject[]) => void
  const localApi = apiFor(localWorkspace, [])
  vi.mocked(localApi.projects.list).mockReturnValue(
    new Promise(resolve => {
      resolveLocal = resolve
    })
  )
  const cloudApi = apiFor(cloudWorkspace, [project])

  await render([cloudApi, localApi])

  expect(currentState().loading).toBe(false)
  expect(currentState().workspace?.id).toBe(cloudWorkspace.id)
  expect(currentState().projects).toEqual([project])
  expect(currentState().navigationIncomplete).toBe(true)
  await act(async () => resolveLocal([]))
  expect(currentState().navigationIncomplete).toBe(false)
})

it('opens an authorized project from its detail before global catalogs arrive', async () => {
  const context = { id: 'cloud', public_id: 'public', name: 'Parent' }
  const target = { ...project, workspace_context: context }
  const cloudApi = apiFor(cloudWorkspace, [])
  cloudApi.projects.get = vi.fn(async () => target)
  let resolveProjects!: (projects: CollaborationProject[]) => void
  let resolveWorkspaces!: (workspaces: CollaborationWorkspace[]) => void
  vi.mocked(cloudApi.projects.list).mockReturnValue(
    new Promise(resolve => {
      resolveProjects = resolve
    })
  )
  vi.mocked(cloudApi.workspaces!.list).mockReturnValue(
    new Promise(resolve => {
      resolveWorkspaces = resolve
    })
  )

  await render([cloudApi], { ...location, workspaceId: null })

  expect(currentState().loading).toBe(false)
  expect(currentState().projects).toEqual([target])
  expect(currentState().workspace).toBeNull()
  expect(currentState().workspaceNavigationContext).toEqual({
    ...context,
    location: 'cloud',
  })
  await act(async () => {
    resolveProjects([])
    resolveWorkspaces([])
  })
  expect(currentState().error).toBeNull()
  expect(currentState().projects).toEqual([target])
})

it.each([false, true])(
  'removes a cached project after refresh excludes it, with an unrelated failure=%s',
  async unrelatedFailure => {
    const cloudApi = apiFor(cloudWorkspace, [project])
    const localApi = apiFor(localWorkspace, [])
    const sources = [cloudApi, localApi]
    await render(sources)
    expect(currentState().projects).toContainEqual(project)
    let resolveProjects!: (projects: CollaborationProject[]) => void
    vi.mocked(cloudApi.projects.list).mockReturnValue(
      new Promise(resolve => {
        resolveProjects = resolve
      })
    )
    if (unrelatedFailure) {
      vi.mocked(localApi.workspaces!.list).mockRejectedValue(new Error('Unavailable'))
    }

    await render(sources, location, 'refresh')
    expect(currentState().projects).toContainEqual(project)
    await act(async () => resolveProjects([]))

    expect(currentState().navigationProjects).not.toContainEqual(project)
    expect(currentState().projects).not.toContainEqual(project)
    await render([...sources], location, 'refresh')
    expect(currentState().navigationProjects).not.toContainEqual(project)
    expect(currentState().projects).not.toContainEqual(project)
  }
)

it.each([
  { detailContext: true, navigationContext: false, error: null },
  { detailContext: false, navigationContext: true, error: null },
  { detailContext: false, navigationContext: false, error: 'Failed' },
])(
  'handles unavailable catalogs with detail context=$detailContext and navigation context=$navigationContext',
  async ({ detailContext, navigationContext, error }) => {
    const context = { id: 'cloud', public_id: 'public', name: 'Parent' }
    const target = detailContext ? { ...project, workspace_context: context } : project
    const cloudApi = apiFor(cloudWorkspace, [])
    cloudApi.projects.get = vi.fn(async () => target)
    vi.mocked(cloudApi.projects.list).mockRejectedValue(new Error('Unavailable'))
    vi.mocked(cloudApi.workspaces!.list).mockRejectedValue(new Error('Unavailable'))
    if (navigationContext) {
      cloudApi.workspaces!.getNavigationContext = vi.fn(async () => ({
        ...context,
        location: 'cloud' as const,
      }))
    }

    await render([cloudApi], { ...location, workspaceId: null })

    expect(currentState().loading).toBe(false)
    expect(currentState().error).toBe(error)
    if (!error) {
      expect(currentState().projects).toEqual([target])
      expect(currentState().workspaceNavigationContext).toEqual({
        ...context,
        location: 'cloud',
      })
    }
  }
)

it.each(['agents', 'members', 'collaboration-participants', 'collaboration-groups'] as const)(
  'keeps the %s settings shell independent of participant requests',
  async workspaceView => {
    const api = apiFor(cloudWorkspace, [])
    Object.assign(api.workspaces!, {
      get: vi.fn(async () => cloudWorkspace),
      listMembers: vi.fn(() => new Promise(() => {})),
      listAgents: vi.fn(() => new Promise(() => {})),
      listCollaborationGroups: vi.fn(() => new Promise(() => {})),
    })
    await render([api], { ...location, projectId: null, workspaceView })
    expect(currentState().loading).toBe(false)
    expect(currentState().workspace?.id).toBe('cloud')
    expect(api.workspaces!.listMembers).not.toHaveBeenCalled()
    expect(api.workspaces!.listAgents).not.toHaveBeenCalled()
    expect(api.workspaces!.listCollaborationGroups).not.toHaveBeenCalled()
  }
)
