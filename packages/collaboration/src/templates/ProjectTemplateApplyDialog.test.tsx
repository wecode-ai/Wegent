// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import { builtinCollaborationTemplates } from './builtins'
import { ProjectTemplateApplyDialog } from './ProjectTemplateApplyDialog'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function fixture() {
  const document = structuredClone(builtinCollaborationTemplates()[0].document)
  const collaboration = document.spec.resources.collaboration
  delete collaboration.agents
  const group = collaboration.groups[0]
  group.roles = [{ key: 'owner', name: '负责人', responsibility: '', defaultKind: 'human' }]
  group.leaderRole = 'owner'
  group.stages = []
  collaboration.groups = [group]
  const project = { id: 'project', access_role: 'Owner', tags: [], version: 1 }
  const api = {
    projects: {
      get: vi.fn(async () => project),
      listCollaborationGroups: vi.fn(async () => []),
      createCollaborationGroup: vi.fn(async () => ({
        id: 'group',
        name: group.name,
      })),
      update: vi.fn(async () => project),
    },
    members: { list: vi.fn(async () => [{ user_id: 7, user_name: 'Owner' }]) },
    agents: { list: vi.fn(async () => []) },
    automations: { list: vi.fn(async () => []), create: vi.fn() },
  }
  const applied = vi.fn()
  const render = () =>
    act(async () =>
      root.render(
        <ProjectTemplateApplyDialog
          api={api as unknown as SharedWorkspaceApi}
          projectId="project"
          document={document}
          locale="zh-CN"
          currentUserId={7}
          onClose={() => {}}
          onApplied={applied}
        />
      )
    )
  return { api, render, applied, project }
}

it('loads only the chosen project and persists groups, routing and board after confirmation', async () => {
  const { api, render, applied, project } = fixture()
  await render()
  expect(api.members.list).toHaveBeenCalledWith('project')
  expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="template-bindings-apply"]')!.click()
  )
  expect(api.projects.createCollaborationGroup).toHaveBeenCalledOnce()
  expect(api.automations.create).toHaveBeenCalledWith(
    'project',
    expect.objectContaining({ targetId: 'group' })
  )
  expect(api.projects.update).toHaveBeenCalledWith(
    'project',
    expect.objectContaining({ boardViews: expect.any(Object) })
  )
  expect(applied).toHaveBeenCalledWith(project)
})

it('rejects revoked management access before loading candidates or changing project resources', async () => {
  const { api, render } = fixture()
  api.projects.get.mockResolvedValue({
    id: 'project',
    access_role: 'Viewer',
    tags: [],
    version: 1,
  })
  await render()
  expect(container.textContent).toContain('只有项目所有者或维护者')
  expect(api.members.list).not.toHaveBeenCalled()
  expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled()
})

it('shows a failed prerequisite and retries without enabling a partial context', async () => {
  const { api, render } = fixture()
  api.members.list.mockRejectedValueOnce(new Error('offline'))
  await render()
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="template-bindings-apply"]')).toBeNull()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="template-project-retry"]')!.click()
  )
  expect(container.querySelector('[data-testid="template-bindings-apply"]')).not.toBeNull()
  expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled()
})
