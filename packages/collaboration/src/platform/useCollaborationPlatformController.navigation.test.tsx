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
let currentCommands: ReturnType<typeof useCollaborationPlatformController>['commands']

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
  const { state, commands } = useCollaborationPlatformController({
    ...props,
    loadFailedMessage: 'Failed',
  })
  currentCommands = commands
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

it('finishes local navigation after opening a newly created cloud workspace', async () => {
  let resolveLocal!: (workspaces: CollaborationWorkspace[]) => void
  const localApi = apiFor(localWorkspace, [])
  vi.mocked(localApi.workspaces!.list).mockReturnValue(
    new Promise(resolve => {
      resolveLocal = resolve
    })
  )
  const createdWorkspace = { ...cloudWorkspace, project_count: 0 }
  const cloudApi = apiFor(createdWorkspace, [])
  vi.mocked(cloudApi.workspaces!.list).mockResolvedValue([])
  Object.assign(cloudApi.workspaces!, {
    create: vi.fn(async () => {
      vi.mocked(cloudApi.workspaces!.list).mockResolvedValue([createdWorkspace])
      return createdWorkspace
    }),
    get: vi.fn(async () => createdWorkspace),
    listMembers: vi.fn(async () => []),
  })
  cloudApi.projects.create = vi.fn(async () => project)
  Object.assign(cloudApi, {
    issues: { getBoardSnapshot: vi.fn(async () => ({ items: [] })) },
  })
  const sources = [cloudApi, localApi]
  await render(sources, { ...location, workspaceId: null, projectId: null })
  await act(async () => {
    await currentCommands.createWorkspace({ name: 'Created cloud space' })
  })
  await render(sources, { ...location, projectId: null })

  expect(currentState().workspace?.id).toBe(createdWorkspace.id)
  expect(currentState().loading).toBe(false)
  await act(async () => {
    await currentCommands.createProject({ name: 'Created cloud project' })
  })
  expect(currentState().navigationProjects).toContainEqual(project)
  await act(async () => resolveLocal([localWorkspace]))

  expect(
    currentState()
      .workspaces.map(workspace => workspace.id)
      .sort()
  ).toEqual(['cloud', 'local'])
  expect(currentState().navigationProjects).toContainEqual(project)
  expect(currentState().navigationIncomplete).toBe(false)
  expect(currentState().error).toBeNull()
})

it('reuses a cached workspace after an unrelated navigation source has failed', async () => {
  const cloudApi = apiFor(cloudWorkspace, [])
  vi.mocked(cloudApi.projects.list).mockRejectedValue(new Error('Unavailable'))
  vi.mocked(cloudApi.workspaces!.list).mockRejectedValue(new Error('Unavailable'))
  cloudApi.workspaces!.get = vi.fn(async () => localWorkspace)
  const localApi = apiFor(localWorkspace, [])
  const sources = [cloudApi, localApi]
  await render(sources, { ...location, workspaceId: null, projectId: null })
  await render(sources, {
    ...location,
    workspaceId: localWorkspace.id,
    workspaceView: 'members',
    projectId: null,
  })

  expect(currentState().workspace?.id).toBe(localWorkspace.id)
  expect(currentState().loading).toBe(false)
  expect(currentState().navigationIncomplete).toBe(true)
  expect(cloudApi.projects.list).toHaveBeenCalledOnce()
  expect(cloudApi.workspaces!.list).toHaveBeenCalledOnce()
})

it('clears the previous workspace data while navigation for a new workspace is pending', async () => {
  const localProject = { ...project, id: 'local-project', workspace_id: 'local' }
  const localApi = apiFor(localWorkspace, [localProject])
  const cloudApi = apiFor(cloudWorkspace, [])
  Object.assign(cloudApi, {
    resources: {
      list: vi.fn(async () => ({
        agents: [{ id: 'local-agent' }],
        execution_environments: [{ id: 'local-runtime' }],
      })),
    },
    issues: { getBoardSnapshot: vi.fn(async () => ({ items: [{ id: 'local-issue' }] })) },
  })
  Object.assign(cloudApi.workspaces!, {
    get: vi.fn(async (id: string) => (id === 'local' ? localWorkspace : cloudWorkspace)),
    listMembers: vi.fn(async () => [{ id: 1, user_id: 1 }]),
  })
  const sources = [cloudApi, localApi]
  await render(sources, { ...location, workspaceId: 'local', projectId: null })
  expect(currentState().members).toHaveLength(1)
  expect(currentState().resources.agents).toHaveLength(1)
  expect(currentState().projectIssues[localProject.id].status).toBe('available')

  let resolveLocal!: (workspaces: CollaborationWorkspace[]) => void
  vi.mocked(localApi.workspaces!.list).mockReturnValue(
    new Promise(resolve => {
      resolveLocal = resolve
    })
  )
  await render(sources, { ...location, projectId: null }, 'refresh')

  expect(currentState().workspace?.id).toBe('cloud')
  expect(currentState().loading).toBe(false)
  expect(currentState().members).toEqual([])
  expect(currentState().resources).toEqual({ agents: [], execution_environments: [] })
  expect(currentState().projectIssues).toEqual({})
  expect(currentState().projects).not.toContainEqual(localProject)
  await act(async () => resolveLocal([localWorkspace]))
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
