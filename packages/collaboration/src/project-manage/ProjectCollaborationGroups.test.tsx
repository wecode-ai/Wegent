// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCollaborationGroupsConfiguration } from '../platform/WorkspaceResourceConfiguration'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup, CollaborationMember, CollaborationProject } from '../types'
import { useCollaborationWorkspaceController } from '../workspace-controller/useCollaborationWorkspaceController'
import { ProjectCollaborationGroups } from './ProjectCollaborationGroups'

const view = vi.hoisted(() => ({
  props: null as ComponentProps<typeof WorkspaceCollaborationGroupsConfiguration> | null,
}))
vi.mock('../platform/WorkspaceResourceConfiguration', () => ({
  WorkspaceCollaborationGroupsConfiguration: (props: NonNullable<typeof view.props>) => {
    view.props = props
    const [selection, setSelection] = useState('')
    return (
      <div>
        {props.groups.map(group => group.name).join(', ')}
        <input
          data-testid="editor-selection"
          value={selection}
          onChange={() => setSelection('human:1')}
        />
        <button data-testid="select-member" onClick={() => setSelection('human:1')}>
          Select
        </button>
      </div>
    )
  },
}))

const group = {
  id: 'group-1',
  name: 'Delivery',
  owner_type: 'project',
} as CollaborationGroup
const member = { id: 1, user_id: 1, user_name: 'Alice' } as CollaborationMember
const agent = { id: 'agent-1', name: 'Reviewer' }
let root: Root | undefined
let container: HTMLDivElement

function apiFor(listMembers = vi.fn(async () => [member])) {
  return {
    projects: {
      listCollaborationGroups: vi.fn(async () => [group]),
      createCollaborationGroup: vi.fn(async () => group),
      updateCollaborationGroup: vi.fn(async () => group),
    },
    agents: { list: vi.fn(async () => [agent]) },
    members: { list: listMembers },
  } as unknown as SharedWorkspaceApi
}

async function render(
  api: SharedWorkspaceApi,
  projectId = 'project-1',
  workspaceId = 'workspace-1'
) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () =>
    root!.render(
      <ProjectCollaborationGroups
        api={api}
        projectId={projectId}
        workspaceId={workspaceId}
        members={[]}
        agents={[]}
        locale="en"
        canManage
      />
    )
  )
}

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
  view.props = null
})

describe('project collaboration-group loading', () => {
  it('keeps groups and agents usable after members fail, completes mutations, and retries members', async () => {
    const listMembers = vi
      .fn()
      .mockRejectedValueOnce(new Error('Members unavailable'))
      .mockResolvedValue([member])
    const api = apiFor(listMembers)
    await render(api)
    expect(container.textContent).toContain('Delivery')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Members unavailable')
    expect(view.props!.agents).toEqual([agent])
    const input = {
      name: 'Delivery',
      leader: { kind: 'agent' as const, id: agent.id, responsibility: '' },
      members: [],
    }
    await act(async () => {
      await expect(view.props!.commands.createCollaborationGroup!(input)).resolves.toEqual(group)
      await expect(
        view.props!.commands.updateCollaborationGroup!(group.id, input)
      ).resolves.toEqual(group)
    })
    expect(api.projects.createCollaborationGroup).toHaveBeenCalledOnce()
    expect(api.projects.updateCollaborationGroup).toHaveBeenCalledOnce()
    expect(listMembers).toHaveBeenCalledOnce()
    expect(view.props!.groups).toEqual([group])
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="project-group-members-retry"]')!
        .click()
    )
    expect(listMembers).toHaveBeenCalledTimes(2)
    expect(view.props!.members).toEqual([member])
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders successful groups without waiting for members and ignores an old project response', async () => {
    let resolveOld!: (members: CollaborationMember[]) => void
    const listMembers = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveOld = resolve
          })
      )
      .mockResolvedValue([{ ...member, user_name: 'Bob' }])
    const api = apiFor(listMembers)
    await render(api)
    expect(view.props!.groups).toEqual([group])
    expect(view.props!.agents).toEqual([agent])
    await render(api, 'project-2')
    await act(async () => resolveOld([member]))
    expect(view.props!.members[0].user_name).toBe('Bob')
  })

  it('reports initial group reload failures without discarding successfully loaded members', async () => {
    const api = apiFor()
    vi.mocked(api.projects.listCollaborationGroups!).mockRejectedValue(
      new Error('Groups unavailable')
    )
    await render(api)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Groups unavailable')
    expect(view.props!.members).toEqual([member])
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it.each(['success', 'failure'] as const)(
  'ignores A groups after B %s, including workspace groups and agents',
  async outcome => {
    const a = deferred<CollaborationGroup[]>()
    const bGroup = { ...group, id: 'group-b', name: 'B' }
    const api = apiFor()
    api.workspaces = {
      listCollaborationGroups: vi.fn(async id => [{ ...group, id }]),
    } as SharedWorkspaceApi['workspaces']
    vi.mocked(api.projects.listCollaborationGroups!)
      .mockReturnValueOnce(a.promise)
      .mockImplementationOnce(async () => {
        if (outcome === 'failure') throw new Error('B unavailable')
        return [bGroup]
      })
    vi.mocked(api.agents.list).mockImplementation(async id => [{ ...agent, id }])
    await render(api, 'a', 'workspace-a')
    await render(api, 'b', 'workspace-b')
    await act(async () => a.resolve([group]))
    expect(view.props!.groups).toEqual(outcome === 'success' ? [bGroup] : [])
    expect(view.props!.availableGroups).toEqual(
      outcome === 'success' ? [{ ...group, id: 'workspace-b' }] : []
    )
    expect(view.props!.agents).toEqual(outcome === 'success' ? [{ ...agent, id: 'b' }] : [])
    expect(container.textContent?.includes('B unavailable')).toBe(outcome === 'failure')
    if (outcome === 'success') {
      await act(async () => {
        await view.props!.commands.updateCollaborationGroup!(bGroup.id, {
          name: 'B edited',
        })
      })
      expect(api.projects.updateCollaborationGroup).toHaveBeenCalledWith('b', bGroup.id, {
        name: 'B edited',
      })
    }
  }
)

it('clears loaded A members and editor selections while B is pending, rejected, and retried', async () => {
  const b = deferred<CollaborationMember[]>()
  const list = vi
    .fn()
    .mockResolvedValueOnce([member])
    .mockReturnValueOnce(b.promise)
    .mockResolvedValueOnce([{ ...member, user_id: 2, user_name: 'Bob' }])
  const api = apiFor(list)
  await render(api, 'a')
  expect(view.props!.members).toEqual([member])
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-member"]')!.click()
  )
  expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('human:1')
  await render(api, 'b')
  expect(view.props!.members).toEqual([])
  expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('')
  await act(async () => b.reject('B members unavailable'))
  expect(view.props!.members).toEqual([])
  expect(container.textContent).toContain('B members unavailable')
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="project-group-members-retry"]')!
      .click()
  )
  expect(view.props!.members.map(value => value.user_name)).toEqual(['Bob'])
  expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('')
})

it.each(['workspace', 'api'] as const)(
  'invalidates directories and drafts when the %s identity changes',
  async identity => {
    const api = apiFor()
    await render(api)
    const oldCommands = view.props!.commands
    const nextApi = identity === 'api' ? apiFor(vi.fn(() => new Promise(() => {}))) : api
    if (identity === 'workspace') vi.mocked(api.members.list).mockReturnValue(new Promise(() => {}))
    await render(nextApi, 'project-1', identity === 'workspace' ? 'workspace-2' : 'workspace-1')
    expect(view.props!.members).toEqual([])
    await expect(oldCommands.createCollaborationGroup!({ name: 'Stale' })).rejects.toThrow(
      'no longer active'
    )
    expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled()
  }
)

it('does not reload A when its pending save completes after navigating to B', async () => {
  const save = deferred<CollaborationGroup>()
  const api = apiFor()
  vi.mocked(api.projects.updateCollaborationGroup!).mockReturnValueOnce(save.promise)
  await render(api, 'a')
  let pending!: Promise<unknown>
  act(() => {
    pending = view.props!.commands.updateCollaborationGroup!(group.id, {
      name: 'Edited A',
    })
  })
  await render(api, 'b')
  const count = vi.mocked(api.projects.listCollaborationGroups!).mock.calls.length
  await act(async () => {
    save.resolve(group)
    await pending
  })
  expect(api.projects.listCollaborationGroups).toHaveBeenCalledTimes(count)
  expect(api.projects.updateCollaborationGroup).toHaveBeenCalledWith('a', group.id, {
    name: 'Edited A',
  })
})

it('ignores an earlier same-scope reload after a newer reload fails', async () => {
  const old = deferred<CollaborationGroup[]>()
  const api = apiFor()
  await render(api)
  vi.mocked(api.projects.listCollaborationGroups!)
    .mockReturnValueOnce(old.promise)
    .mockRejectedValueOnce(new Error('Latest reload failed'))
  let first!: Promise<unknown>
  act(() => {
    first = view.props!.commands.createCollaborationGroup!({ name: 'First' })
  })
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await expect(
      view.props!.commands.createCollaborationGroup!({ name: 'Second' })
    ).rejects.toThrow('Latest reload failed')
  })
  await act(async () => {
    old.resolve([{ ...group, name: 'Obsolete' }])
    await first
  })
  expect(view.props!.groups).toEqual([group])
  expect(container.textContent).toContain('Latest reload failed')
})

it('keeps groups scoped when the real metadata-only controller switches cached projects in one batch', async () => {
  const projects = ['a', 'b'].map(
    id =>
      ({ id, name: id, workspace_id: 'workspace', task_provider: 'local' }) as CollaborationProject
  )
  const api = apiFor()
  api.projects.list = vi.fn(async () => projects)
  const a = deferred<CollaborationGroup[]>()
  vi.mocked(api.projects.listCollaborationGroups!)
    .mockReturnValueOnce(a.promise)
    .mockResolvedValue([{ ...group, id: 'b-group', name: 'B' }])
  const messages = { loadFailed: 'load', saveFailed: 'save', conflict: 'conflict' }
  function Harness({ projectId }: { projectId: string | null }) {
    const { state } = useCollaborationWorkspaceController({
      api,
      location: { projectId, issueId: null, view: 'manage' },
      messages,
      preloadHomeSnapshots: false,
      myWorkEnabled: false,
      pollIntervalMs: 0,
    })
    return state.loading || !state.project ? null : (
      <ProjectCollaborationGroups
        api={api}
        projectId={state.project.id}
        workspaceId={state.project.workspace_id}
        members={state.members}
        agents={state.agents}
        locale="en"
        canManage
      />
    )
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Harness projectId={null} />))
  await act(async () => root!.render(<Harness projectId="a" />))
  await act(async () => root!.render(<Harness projectId="b" />))
  await act(async () => a.resolve([group]))
  expect(view.props!.groups.map(value => value.id)).toEqual(['b-group'])
  expect(api.projects.list).toHaveBeenCalledOnce()
})

it('ignores A post-save reload already in flight when B becomes active', async () => {
  const reloadA = deferred<CollaborationGroup[]>()
  const api = apiFor()
  await render(api, 'a')
  vi.mocked(api.projects.listCollaborationGroups!)
    .mockReturnValueOnce(reloadA.promise)
    .mockResolvedValue([{ ...group, id: 'b-group', name: 'B' }])
  let pending!: Promise<unknown>
  await act(async () => {
    pending = view.props!.commands.updateCollaborationGroup!(group.id, { name: 'Saved A' })
    await Promise.resolve()
  })
  await render(api, 'b')
  await act(async () => {
    reloadA.resolve([{ ...group, name: 'Saved A' }])
    await pending
  })
  expect(view.props!.groups.map(value => value.id)).toEqual(['b-group'])
})
