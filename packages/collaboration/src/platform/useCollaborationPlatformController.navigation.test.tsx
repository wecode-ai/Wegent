// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, startTransition, Suspense } from 'react'
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

it('retains late local navigation after creating and opening a cloud project', async () => {
  let resolveLocal!: (workspaces: CollaborationWorkspace[]) => void
  const localApi = apiFor(localWorkspace, [])
  vi.mocked(localApi.workspaces!.list).mockReturnValue(
    new Promise(resolve => {
      resolveLocal = resolve
    })
  )
  const cloudApi = apiFor(cloudWorkspace, [])
  let createdWorkspace: CollaborationWorkspace | undefined
  let createdProject: CollaborationProject | undefined
  vi.mocked(cloudApi.workspaces!.list).mockImplementation(async () =>
    createdWorkspace ? [createdWorkspace] : []
  )
  vi.mocked(cloudApi.projects.list).mockImplementation(async () =>
    createdProject ? [createdProject] : []
  )
  cloudApi.workspaces!.create = vi.fn(async () => {
    createdWorkspace = { ...cloudWorkspace, project_count: 0 }
    return createdWorkspace
  })
  cloudApi.projects.create = vi.fn(async () => {
    createdProject = project
    return createdProject
  })
  const sources = [cloudApi, localApi]
  await render(sources, { ...location, workspaceId: null, projectId: null })

  await act(async () => {
    await commands.createWorkspace({ name: 'New cloud workspace' })
    await commands.createProject({ name: 'New cloud project' }, cloudWorkspace.id)
  })
  await render(sources)

  expect(currentState().loading).toBe(false)
  expect(currentState().workspace?.id).toBe(cloudWorkspace.id)
  expect(currentState().projects).toContainEqual(project)
  await act(async () => resolveLocal([localWorkspace]))

  expect(
    currentState()
      .workspaces.map(workspace => workspace.id)
      .sort()
  ).toEqual(['cloud', 'local'])
  expect(currentState().navigationIncomplete).toBe(false)
  expect(currentState().projects).toContainEqual(project)
})

it('opens a newly created empty workspace before unrelated local navigation settles', async () => {
  let resolveLocal!: (workspaces: CollaborationWorkspace[]) => void
  const localApi = apiFor(localWorkspace, [])
  vi.mocked(localApi.workspaces!.list).mockReturnValue(
    new Promise(resolve => {
      resolveLocal = resolve
    })
  )
  const emptyWorkspace = { ...cloudWorkspace, project_count: 0 }
  const cloudApi = apiFor(emptyWorkspace, [])
  let created = false
  vi.mocked(cloudApi.workspaces!.list).mockImplementation(async () =>
    created ? [emptyWorkspace] : []
  )
  cloudApi.workspaces!.create = vi.fn(async () => {
    created = true
    return emptyWorkspace
  })
  cloudApi.workspaces!.get = vi.fn(async () => emptyWorkspace)
  cloudApi.workspaces!.listMembers = vi.fn(async () => [])
  const sources = [cloudApi, localApi]
  await render(sources, { ...location, workspaceId: null, projectId: null })
  await act(async () => {
    await commands.createWorkspace({ name: 'New empty workspace' })
  })

  await render(sources, { ...location, projectId: null })

  expect(currentState().loading).toBe(false)
  expect(currentState().workspace?.id).toBe(emptyWorkspace.id)
  expect(currentState().projects).toEqual([])
  expect(currentState().error).toBeNull()
  await act(async () => resolveLocal([localWorkspace]))

  expect(
    currentState()
      .workspaces.map(workspace => workspace.id)
      .sort()
  ).toEqual(['cloud', 'local'])
  expect(currentState().navigationIncomplete).toBe(false)
  expect(currentState().workspace?.id).toBe(emptyWorkspace.id)
  expect(currentState().error).toBeNull()
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

it('keeps pending refreshes on the committed route when an uncommitted route suspends', async () => {
  const localResponses: Array<(workspaces: CollaborationWorkspace[]) => void> = []
  const localApi = apiFor(localWorkspace, [])
  vi.mocked(localApi.workspaces!.list).mockImplementation(
    () => new Promise(resolve => localResponses.push(resolve))
  )
  const cloudApi = apiFor(cloudWorkspace, [project])
  const committedSources = [cloudApi, localApi]
  const otherApi = apiFor({ id: 'other' } as CollaborationWorkspace, [])
  let releaseSuspension!: () => void
  const suspension = new Promise<void>(resolve => {
    releaseSuspension = resolve
  })
  const suspended = vi.fn()
  function Suspend({ active }: { active: boolean }) {
    if (active) {
      suspended()
      throw suspension
    }
    return null
  }
  function Frame({ pending = false }: { pending?: boolean }) {
    const sources = pending ? [otherApi] : committedSources
    return (
      <Suspense fallback={<div>Loading route</div>}>
        <Harness
          api={sources[0]}
          navigationApis={sources}
          location={pending ? { ...location, workspaceId: null, projectId: null } : location}
        />
        <Suspend active={pending} />
      </Suspense>
    )
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  try {
    await act(async () => root!.render(<Frame />))
    const committedCommands = commands
    await act(async () => {
      startTransition(() => root!.render(<Frame pending />))
    })
    expect(suspended).toHaveBeenCalled()

    await act(async () => committedCommands.registerProject({ ...project, version: 2 }))

    expect(otherApi.projects.list).not.toHaveBeenCalled()
    expect(currentState().workspace?.id).toBe(cloudWorkspace.id)
  } finally {
    await act(async () => {
      root!.unmount()
      root = undefined
      releaseSuspension()
      for (const resolve of localResponses) resolve([])
    })
  }
})

it.each([
  { detail: 'workspace', mutation: 'registered' },
  { detail: 'workspace', mutation: 'archived' },
  { detail: 'navigation context', mutation: 'registered' },
  { detail: 'navigation context', mutation: 'archived' },
])(
  'preserves projects after they are $mutation while $detail details are pending',
  async ({ detail, mutation }) => {
    const detailResponses: Array<() => void> = []
    const deferDetail = <T,>(value: T) =>
      new Promise<T>(resolve => detailResponses.push(() => resolve(value)))
    const cloudApi = apiFor(cloudWorkspace, [project])
    cloudApi.workspaces!.get = vi.fn(() => deferDetail(cloudWorkspace))
    if (detail === 'navigation context') {
      vi.mocked(cloudApi.workspaces!.list).mockResolvedValue([])
      cloudApi.workspaces!.getNavigationContext = vi.fn(() =>
        deferDetail({ id: 'cloud', public_id: 'cloud', name: 'Cloud', location: 'cloud' as const })
      )
    }
    const createdProject = { ...project, id: 'created-project', version: 1 }
    cloudApi.projects.archive = vi.fn(async () => {
      vi.mocked(cloudApi.projects.list).mockResolvedValue([])
    })
    try {
      await render([cloudApi], {
        ...location,
        projectId: detail === 'workspace' ? null : project.id,
        workspaceView: 'settings',
      })
      expect(detailResponses).toHaveLength(1)
      if (mutation === 'registered') {
        vi.mocked(cloudApi.projects.list).mockResolvedValue([project, createdProject])
        await act(async () => commands.registerProject(createdProject))
      } else {
        await act(async () => commands.archiveProject(project))
      }

      expect(detailResponses).toHaveLength(2)
      await act(async () => detailResponses[0]())

      if (mutation === 'registered') {
        expect(currentState().projects).toContainEqual(createdProject)
      } else {
        expect(currentState().projects).not.toContainEqual(project)
      }
      await act(async () => detailResponses.at(-1)!())
      if (mutation === 'registered') {
        expect(currentState().projects).toContainEqual(createdProject)
      } else {
        expect(currentState().projects).not.toContainEqual(project)
      }
    } finally {
      await act(async () => {
        for (const resolve of detailResponses) resolve()
      })
    }
  }
)

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

it('opens a standalone project immediately and fills the cold navigation independently', async () => {
  const target = { ...project, workspace_id: undefined }
  const cloudApi = apiFor(cloudWorkspace, [])
  cloudApi.projects.get = vi.fn(async () => target)
  let finish!: (projects: CollaborationProject[]) => void
  vi.mocked(cloudApi.projects.list).mockReturnValue(
    new Promise(resolve => {
      finish = resolve
    })
  )
  await render([cloudApi], { ...location, workspaceId: null })
  expect(currentState().loading).toBe(false)
  expect(currentState().projects).toEqual([target])
  expect(cloudApi.projects.list).toHaveBeenCalledOnce()
  const sibling = { ...project, id: 'sibling' }
  await act(async () => finish([sibling]))
  expect(currentState().workspaces).toEqual([cloudWorkspace])
  expect(currentState().navigationProjects).toEqual([sibling, target])
  expect(currentState().projects).toEqual([target])
  expect(currentState().error).toBeNull()
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

it('finishes pending navigation after opening a newly created workspace', async () => {
  let resolveLocal!: (workspaces: CollaborationWorkspace[]) => void
  const localApi = apiFor(localWorkspace, [])
  vi.mocked(localApi.workspaces!.list).mockReturnValue(
    new Promise(resolve => {
      resolveLocal = resolve
    })
  )
  const createdWorkspace = { ...cloudWorkspace, project_count: 0 }
  const cloudApi = apiFor(cloudWorkspace, [])
  vi.mocked(cloudApi.workspaces!.list).mockResolvedValue([])
  cloudApi.workspaces!.create = vi.fn(async () => {
    vi.mocked(cloudApi.workspaces!.list).mockResolvedValue([createdWorkspace])
    return createdWorkspace
  })
  cloudApi.workspaces!.get = vi.fn(async () => createdWorkspace)
  cloudApi.workspaces!.listMembers = vi.fn(async () => [])
  const sources = [cloudApi, localApi]
  await render(sources, { ...location, workspaceId: null, projectId: null })
  expect(localApi.workspaces!.list).toHaveBeenCalledOnce()

  await act(async () => {
    await commands.createWorkspace({ name: 'New space' })
  })
  await render(sources, { ...location, projectId: null })
  await act(async () => resolveLocal([localWorkspace]))

  expect(
    currentState()
      .workspaces.map(workspace => workspace.id)
      .sort()
  ).toEqual(['cloud', 'local'])
  expect(currentState().navigationIncomplete).toBe(false)
})
