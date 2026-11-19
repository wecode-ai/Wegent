// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ResourceCatalogPage } from './ResourceCatalogPage'
import { platformMessages } from './platformMessages'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type {
  CollaborationGroup,
  CollaborationWorkspace,
  CollaborationWorkspaceMember,
} from '../types'
import type { ResourceCatalogKind } from './resourceCatalogModel'

const workspace = {
  id: 'space',
  location: 'cloud',
  name: 'Space',
  namespace: 'team',
} as CollaborationWorkspace
const workspaces = [workspace]
const group: CollaborationGroup = {
  id: 'team',
  workspace_id: workspace.id,
  owner_type: 'workspace',
  owner_id: workspace.id,
  name: 'Team',
  description: '',
  leader: { kind: 'human', id: '7', responsibility: '' },
  members: [],
  coordination_mode: 'manager',
  stages: [],
  version: 1,
  created_by_user_id: 7,
  created_at: '',
  updated_at: '',
}
const members = (name: string) =>
  [{ user_id: 7, user_name: name }] as CollaborationWorkspaceMember[]
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function catalog(
  api: SharedWorkspaceApi,
  kind: ResourceCatalogKind = 'teams',
  spaces = workspaces
) {
  return (
    <ResourceCatalogPage
      api={api}
      domain="cloud"
      kind={kind}
      agents={[]}
      groups={[group]}
      environments={[]}
      locale="en"
      translate={(_key, fallback) => fallback ?? ''}
      canCreateDevice={false}
      workspaces={spaces}
      projects={[]}
      messages={platformMessages.en}
      onAddToWorkspace={async () => {}}
      onCreateAgent={() => {}}
      onCreateDevice={() => {}}
      onCreateLocalAgent={() => {}}
      onCreateTeam={() => {}}
      onDeleteAgent={async () => {}}
      onDeleteTeam={async () => {}}
      onManageResource={() => {}}
    />
  )
}
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('does not show names from the previous API owner while the new roster is pending', async () => {
  const pending = deferred<CollaborationWorkspaceMember[]>()
  const first = {
    workspaces: { listMembers: vi.fn(async () => members('Previous owner')) },
  } as unknown as SharedWorkspaceApi
  const second = {
    workspaces: { listMembers: vi.fn(() => pending.promise) },
  } as unknown as SharedWorkspaceApi
  await act(async () => root.render(catalog(first)))
  expect(container.textContent).toContain('Previous owner')
  await act(async () => root.render(catalog(second)))
  expect(container.textContent).not.toContain('Previous owner')
  await act(async () => pending.resolve(members('Current owner')))
  expect(container.textContent).toContain('Current owner')
})

it('only reads rosters for teams and ignores a response after changing the workspace list', async () => {
  const pending = deferred<CollaborationWorkspaceMember[]>()
  const listMembers = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(members('Current roster'))
  const api = { workspaces: { listMembers } } as unknown as SharedWorkspaceApi
  await act(async () => root.render(catalog(api, 'agents')))
  expect(listMembers).not.toHaveBeenCalled()
  await act(async () => root.render(catalog(api)))
  await act(async () => root.render(catalog(api, 'teams', [...workspaces])))
  await act(async () => pending.resolve(members('Detached roster')))
  expect(listMembers).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('Current roster')
  expect(container.textContent).not.toContain('Detached roster')
})

it('keeps the team available when its roster fails to load', async () => {
  const api = {
    workspaces: {
      listMembers: vi.fn().mockRejectedValue(new Error('offline')),
    },
  } as unknown as SharedWorkspaceApi
  await act(async () => root.render(catalog(api)))
  expect(container.textContent).toContain('Team')
  expect(container.textContent).toContain(platformMessages.en.human)
})

it('resets the search when changing the resource kind', async () => {
  const api = {
    workspaces: { listMembers: vi.fn(async () => members('Leader')) },
  } as unknown as SharedWorkspaceApi
  await act(async () => root.render(catalog(api)))
  const input = container.querySelector<HTMLInputElement>(
    '[data-testid="collaboration-teams-search"]'
  )!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'No match'
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(input.value).toBe('No match')
  await act(async () => root.render(catalog(api, 'agents')))
  expect(
    container.querySelector<HTMLInputElement>('[data-testid="collaboration-agents-search"]')?.value
  ).toBe('')
  await act(async () => root.render(catalog(api)))
  expect(
    container.querySelector<HTMLInputElement>('[data-testid="collaboration-teams-search"]')?.value
  ).toBe('')
  expect(container.textContent).toContain('Leader')
})
