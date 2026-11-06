// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationWorkspace, CollaborationWorkspaceMember } from '../types'
import type { WorkspaceResourceCommands } from './WorkspaceResourceConfiguration'
import { WorkspaceGroupsPanel, WorkspaceMembersPanel } from './WorkspaceParticipantPanels'

const workspace = {
  id: 'space',
  name: 'Space',
  access_role: 'Owner',
  owner_user_id: 9,
  version: 1,
} as CollaborationWorkspace
const member = {
  user_id: 1,
  user_name: 'Alice',
  email: 'alice@example.org',
  role: 'Developer',
} as CollaborationWorkspaceMember
const translate = createCollaborationTranslator('en')
const commands = {
  updateMember: vi.fn(async () => ({ ...member, role: 'Viewer' })),
} as unknown as WorkspaceResourceCommands
let root: Root
let container: HTMLDivElement
function apiFor() {
  return {
    workspaces: {
      listMembers: vi.fn(async () => [member]),
      listAgents: vi.fn(async () => []),
      listCollaborationGroups: vi.fn(async () => []),
    },
  } as unknown as SharedWorkspaceApi
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function renderMembers(api: SharedWorkspaceApi, id = workspace.id, panelCommands = commands) {
  await act(async () =>
    root.render(
      <WorkspaceMembersPanel
        api={api}
        workspace={{ ...workspace, id }}
        commands={panelCommands}
        locale="en"
        translate={translate}
      />
    )
  )
}
async function click(id: string) {
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click()
  )
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
it('loads members without requesting agents or groups', async () => {
  const api = apiFor()
  await renderMembers(api)
  expect(container.textContent).toContain('Alice')
  expect(api.workspaces!.listMembers).toHaveBeenCalledExactlyOnceWith('space')
  expect(api.workspaces!.listAgents).not.toHaveBeenCalled()
  expect(api.workspaces!.listCollaborationGroups).not.toHaveBeenCalled()
})
it('distinguishes a failed request from an empty roster and retries only members', async () => {
  const api = apiFor()
  vi.mocked(api.workspaces!.listMembers).mockRejectedValueOnce(new Error('Unavailable'))
  await renderMembers(api)
  expect(container.querySelector('[data-testid="workspace-members-error"]')).not.toBeNull()
  expect(container.textContent).not.toContain('No members')
  await click('workspace-members-retry')
  expect(container.textContent).toContain('Alice')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(api.workspaces!.listAgents).not.toHaveBeenCalled()
})
it('ignores late results from the previous workspace and API identity', async () => {
  const oldApi = apiFor()
  const pending = deferred<CollaborationWorkspaceMember[]>()
  vi.mocked(oldApi.workspaces!.listMembers).mockReturnValue(pending.promise)
  await renderMembers(oldApi)
  expect(container.querySelector('[data-testid="workspace-members-loading"]')).not.toBeNull()
  const nextApi = apiFor()
  vi.mocked(nextApi.workspaces!.listMembers).mockResolvedValue([{ ...member, user_name: 'Bob' }])
  await renderMembers(nextApi, 'other')
  await act(async () => pending.resolve([member]))
  expect(container.textContent).toContain('Bob')
  expect(container.textContent).not.toContain('Alice')
})
it('shows the group list before fetching editor candidates, isolates their failure, and leaves members usable', async () => {
  const api = apiFor()
  const pending = deferred<never[]>()
  vi.mocked(api.workspaces!.listAgents).mockReturnValue(pending.promise)
  await act(async () =>
    root.render(
      <WorkspaceGroupsPanel
        api={api}
        workspace={workspace}
        commands={commands}
        locale="en"
        translate={translate}
        initialCreateOpen={false}
        onCreateOpenChange={() => {}}
      />
    )
  )
  expect(container.textContent).toContain('No collaboration groups')
  expect(api.workspaces!.listMembers).not.toHaveBeenCalled()
  expect(api.workspaces!.listAgents).not.toHaveBeenCalled()
  await click('collaboration-group-open-create')
  expect(api.workspaces!.listAgents).toHaveBeenCalledOnce()
  await act(async () => pending.reject(new Error('Agent service failed')))
  expect(
    container.querySelector('[data-testid="workspace-group-participants-error"]')
  ).not.toBeNull()
  await renderMembers(api)
  expect(container.textContent).toContain('Alice')
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('preserves the visible roster when ownership refresh fails and recovers locally', async () => {
  const api = apiFor()
  vi.mocked(api.workspaces!.listMembers)
    .mockResolvedValueOnce([member])
    .mockRejectedValueOnce(new Error('Refresh failed'))
    .mockResolvedValueOnce([{ ...member, role: 'Owner' }])
  const transferOwnership = vi.fn(async () => undefined)
  await renderMembers(api, workspace.id, { ...commands, transferOwnership })
  const select = container.querySelector<HTMLSelectElement>(
    '[data-testid="collaboration-workspace-transfer-user"]'
  )!
  await act(async () => {
    select.value = '1'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click('collaboration-workspace-transfer-submit')
  expect(transferOwnership).toHaveBeenCalledExactlyOnceWith(1, 1)
  expect(container.textContent).toContain('Alice')
  expect(container.querySelector('[data-testid="workspace-members-error"]')).not.toBeNull()
  await click('workspace-members-retry')
  expect(container.querySelector('[data-testid="workspace-members-error"]')).toBeNull()
  expect(
    container.querySelector('[data-testid="collaboration-workspace-member-role-1"]')
  ).toBeNull()
  expect(api.workspaces!.listMembers).toHaveBeenCalledTimes(3)
})
