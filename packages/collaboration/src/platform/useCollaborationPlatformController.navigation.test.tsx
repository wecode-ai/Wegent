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
let commands: ReturnType<typeof useCollaborationPlatformController>['commands']

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
  const controller = useCollaborationPlatformController({
    ...props,
    loadFailedMessage: 'Failed',
  })
  commands = controller.commands
  return <output>{JSON.stringify(controller.state)}</output>
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

it.each(['workspace', 'project', 'archived', 'updated'])(
  'finishes local navigation after opening newly created cloud resources: %s',
  async target => {
    const localResponses: Array<(workspaces: CollaborationWorkspace[]) => void> = []
    const localApi = apiFor(localWorkspace, [])
    vi.mocked(localApi.workspaces!.list).mockImplementation(
      () => new Promise(resolve => localResponses.push(resolve))
    )
    const createdWorkspace = {
      id: 'created',
      project_count: 0,
    } as CollaborationWorkspace
    const createdProject = {
      id: 'created-project',
      workspace_id: 'created',
    } as CollaborationProject
    const cloudApi = apiFor(cloudWorkspace, [project])
    cloudApi.workspaces!.create = vi.fn(async () => {
      vi.mocked(cloudApi.workspaces!.list).mockResolvedValue([cloudWorkspace, createdWorkspace])
      return createdWorkspace
    })
    cloudApi.workspaces!.get = vi.fn(async () => createdWorkspace)
    cloudApi.workspaces!.update = vi.fn(async () => {
      const updated = { ...createdWorkspace, name: 'Renamed workspace', version: 2 }
      vi.mocked(cloudApi.workspaces!.list).mockResolvedValue([cloudWorkspace, updated])
      vi.mocked(cloudApi.workspaces!.get).mockResolvedValue(updated)
      return updated
    })
    cloudApi.projects.create = vi.fn(async () => {
      vi.mocked(cloudApi.projects.list).mockResolvedValue([project, createdProject])
      return createdProject
    })
    cloudApi.projects.archive = vi.fn(async () => {
      vi.mocked(cloudApi.projects.list).mockResolvedValue([project])
    })
    const sources = [cloudApi, localApi]
    const workspaceLocation = {
      ...location,
      workspaceId: createdWorkspace.id,
      workspaceView: 'settings' as const,
      projectId: null,
    }
    try {
      await render(sources, {
        ...location,
        workspaceId: null,
        projectId: null,
      })
      expect(currentState().workspaces).toContainEqual(cloudWorkspace)
      await act(async () => {
        await commands.createWorkspace({ name: 'Created workspace' })
      })
      await render(sources, workspaceLocation)
      expect(currentState().workspace?.id).toBe(createdWorkspace.id)
      expect(currentState().loading).toBe(false)
      await act(async () => localResponses[0]([]))
      if (target === 'project' || target === 'archived') {
        await act(async () => {
          await commands.createProject({ name: 'Created project' })
        })
        const readsAfterCreate = vi.mocked(localApi.workspaces!.list).mock.calls.length
        await act(async () => commands.registerProject(createdProject))
        expect(localApi.workspaces!.list).toHaveBeenCalledTimes(readsAfterCreate)
        await render(sources, {
          ...workspaceLocation,
          projectId: createdProject.id,
        })
        expect(currentState().projects).toContainEqual(createdProject)
        expect(currentState().loading).toBe(false)
      }
      if (target === 'archived') {
        await render(sources, workspaceLocation)
        expect(currentState().projects).toContainEqual(createdProject)
        await act(async () => commands.archiveProject(createdProject))
        expect(currentState().navigationProjects).not.toContainEqual(createdProject)
      }
      if (target === 'updated') {
        await act(async () => commands.updateWorkspace({ version: 1, name: 'Renamed workspace' }))
        expect(currentState().workspace?.name).toBe('Renamed workspace')
      }
      expect(currentState().navigationIncomplete).toBe(true)

      await act(async () => localResponses.at(-1)!([localWorkspace]))

      expect(currentState().workspaces).toContainEqual(localWorkspace)
      expect(currentState().workspaces.map(workspace => workspace.id)).toContain(
        createdWorkspace.id
      )
      if (target === 'project') expect(currentState().projects).toContainEqual(createdProject)
      if (target === 'archived') {
        expect(currentState().navigationProjects).not.toContainEqual(createdProject)
      }
      if (target === 'updated') expect(currentState().workspace?.name).toBe('Renamed workspace')
      expect(currentState().navigationIncomplete).toBe(false)
      await act(async () => {
        for (const resolve of localResponses) resolve([])
      })
      expect(currentState().workspaces).toContainEqual(localWorkspace)
      expect(currentState().navigationIncomplete).toBe(false)
    } finally {
      await act(async () => {
        for (const resolve of localResponses) resolve([])
      })
    }
  }
)

it('ignores an older navigation source after its replacement has completed', async () => {
  let resolveOld!: (workspaces: CollaborationWorkspace[]) => void
  const oldLocalApi = apiFor({ id: 'old-local' } as CollaborationWorkspace, [])
  vi.mocked(oldLocalApi.workspaces!.list).mockReturnValue(
    new Promise(resolve => {
      resolveOld = resolve
    })
  )
  const cloudApi = apiFor(cloudWorkspace, [project])
  const newLocalApi = apiFor(localWorkspace, [])
  const rootLocation = { ...location, workspaceId: null, projectId: null }
  try {
    await render([cloudApi, oldLocalApi], rootLocation)
    await render([cloudApi, newLocalApi], location)
    expect(currentState().workspaces).toContainEqual(localWorkspace)
    expect(currentState().navigationIncomplete).toBe(false)

    await act(async () => resolveOld([{ id: 'old-local' } as CollaborationWorkspace]))

    expect(currentState().workspaces).toContainEqual(localWorkspace)
    expect(currentState().workspaces.map(workspace => workspace.id)).not.toContain('old-local')
    expect(currentState().navigationIncomplete).toBe(false)
  } finally {
    await act(async () => resolveOld([]))
  }
})

it('does not retry a settled failed navigation source after registering a project', async () => {
  const localApi = apiFor(localWorkspace, [])
  vi.mocked(localApi.workspaces!.list).mockRejectedValue(new Error('Unavailable'))
  const cloudApi = apiFor(cloudWorkspace, [project])
  await render([cloudApi, localApi])
  const updated = { ...project, name: 'Updated project', version: 2 }

  await act(async () => commands.registerProject(updated))

  expect(currentState().projects).toContainEqual(updated)
  expect(localApi.workspaces!.list).toHaveBeenCalledOnce()
  expect(currentState().navigationIncomplete).toBe(true)
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
