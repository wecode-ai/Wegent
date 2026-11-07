// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import { builtinCollaborationTemplates } from './builtins'
import { ProjectTemplateApplyDialog } from './ProjectTemplateApplyDialog'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationExecutionEnvironment } from '../types'

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

function fixture(host?: ProjectAgentConfigurationHost) {
  const document = structuredClone(builtinCollaborationTemplates()[0].document)
  const collaboration = document.spec.resources.collaboration
  if (!host) delete collaboration.agents
  const group = collaboration.groups[0]
  if (!host) {
    group.roles = [
      {
        key: 'owner',
        name: '负责人',
        responsibility: '',
        defaultKind: 'human',
      },
    ]
    group.leaderRole = 'owner'
    group.stages = []
  }
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
    agents: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: crypto.randomUUID() })),
    },
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
          agentConfiguration={host}
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

function environmentHost() {
  const environments = [
    {
      id: '73',
      name: 'Project runner A',
      status: 'online',
      can_use: true,
    },
    {
      id: '74',
      name: 'Project runner B',
      status: 'online',
      can_use: true,
    },
    {
      id: '75',
      name: 'Private runner',
      status: 'online',
      can_use: false,
    },
    {
      id: '76',
      name: 'Offline runner',
      status: 'offline',
      can_use: true,
    },
  ] as CollaborationExecutionEnvironment[]
  const host = {
    renderDialog: () => null,
    listTemplateAgentEnvironments: vi.fn(async () => environments),
    templateAgentEnvironmentSettingsHref: () => '/project?view=manage&section=environments',
    resolveTemplateAgentRouting: vi.fn<
      NonNullable<ProjectAgentConfigurationHost['resolveTemplateAgentRouting']>
    >(async (runtime, _location, _projectId, environmentId) => ({
      executionPolicy: {
        mode: 'fixed' as const,
        environment_id: environmentId!,
      },
      modelPolicy: {
        mode: 'fixed' as const,
        model: { runtime, provider: 'native', model_id: 'default' },
      },
    })),
  } satisfies ProjectAgentConfigurationHost
  return host
}

async function click(testId: string) {
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
  )
}

it('lets the user choose between project devices and applies the selected routing', async () => {
  const host = environmentHost()
  const { render, api, applied } = fixture(host)
  await render()
  const select = container.querySelector<HTMLSelectElement>(
    '[data-testid="template-project-environment-select"]'
  )!
  expect([...select.options].map(option => option.value)).toEqual(['', '73', '74'])
  await click('template-bindings-apply')
  expect(container.textContent).toContain('选择执行设备')
  expect(api.agents.create).not.toHaveBeenCalled()
  await act(async () => {
    select.value = '74'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(host.listTemplateAgentEnvironments).toHaveBeenCalledOnce()
  await click('template-bindings-apply')
  expect(host.resolveTemplateAgentRouting).toHaveBeenCalledWith('codex', 'cloud', 'project', '74')
  expect(api.agents.create).toHaveBeenCalledTimes(6)
  expect(applied).toHaveBeenCalledOnce()
})

it('keeps template edits while recovering from device loading failure and missing devices', async () => {
  const host = environmentHost()
  host.listTemplateAgentEnvironments
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce([])
  const { render, api, applied } = fixture(host)
  await render()
  expect(
    container.querySelector('[data-testid="template-project-environment"] [role="alert"]')
  ).not.toBeNull()
  const name = container.querySelector<HTMLInputElement>('[data-testid^="template-group-name-"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      name,
      'My custom group'
    )
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('template-project-environment-refresh')
  expect(container.textContent).toContain('配置设备后，点击刷新即可继续')
  const settings = container.querySelector<HTMLAnchorElement>(
    '[data-testid="template-project-environment-settings"]'
  )!
  expect(settings.getAttribute('href')).toBe('/project?view=manage&section=environments')
  expect(settings.target).toBe('_blank')
  host.listTemplateAgentEnvironments.mockResolvedValueOnce([
    {
      id: '73',
      name: 'Project runner',
      status: 'online',
      can_use: true,
    } as CollaborationExecutionEnvironment,
  ])
  await click('template-project-environment-refresh')
  expect(
    container.querySelector<HTMLInputElement>('[data-testid^="template-group-name-"]')!.value
  ).toBe('My custom group')
  expect(
    container.querySelector<HTMLSelectElement>(
      '[data-testid="template-project-environment-select"]'
    )!.value
  ).toBe('73')
  await click('template-bindings-apply')
  expect(api.projects.createCollaborationGroup).toHaveBeenCalledWith(
    'project',
    expect.objectContaining({ name: 'My custom group' })
  )
  expect(applied).toHaveBeenCalledOnce()
})
