// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCollaborationGroupsConfiguration } from '../platform/WorkspaceResourceConfiguration'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup, CollaborationMember } from '../types'
import { ProjectCollaborationGroups } from './ProjectCollaborationGroups'

const view = vi.hoisted(() => ({
  props: null as ComponentProps<typeof WorkspaceCollaborationGroupsConfiguration> | null,
}))
vi.mock('../platform/WorkspaceResourceConfiguration', () => ({
  WorkspaceCollaborationGroupsConfiguration: (props: NonNullable<typeof view.props>) => {
    view.props = props
    return <div>{props.groups.map(group => group.name).join(', ')}</div>
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

async function render(api: SharedWorkspaceApi, projectId = 'project-1') {
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
