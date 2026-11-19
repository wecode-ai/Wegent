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
import type { CollaborationExecutionEnvironment, CollaborationGroup } from '../types'
import { runnerModelKey, runnerModelIdentity, type RunnerModel } from '../agent-form/runnerRouting'
import { TemplateModelSelection } from './TemplateModelSelection'

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
  if (host?.listTemplateAgentModels && !host.listTemplateAgentEnvironments) {
    host = {
      ...host,
      listTemplateAgentEnvironments: vi.fn(async () => [
        {
          id: 'fixture-device',
          name: 'Fixture runner',
          status: 'online',
          can_use: true,
        } as CollaborationExecutionEnvironment,
      ]),
    }
  }
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
      listCollaborationGroups: vi.fn(async () => [] as CollaborationGroup[]),
      createCollaborationGroup: vi.fn(
        async (_projectId: string, input: Record<string, unknown>) => ({
          ...input,
          id: 'group',
          name: group.name,
        })
      ),
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
  const onClose = vi.fn()
  const render = async (
    agentConfiguration = host,
    configure = true,
    scope: { api?: SharedWorkspaceApi; projectId?: string } = {}
  ) => {
    await act(async () =>
      root.render(
        <ProjectTemplateApplyDialog
          api={scope.api ?? (api as unknown as SharedWorkspaceApi)}
          projectId={scope.projectId ?? 'project'}
          document={document}
          locale="zh-CN"
          currentUserId={7}
          agentConfiguration={agentConfiguration}
          onClose={onClose}
          onApplied={applied}
        />
      )
    )
    const runtime = container.querySelector<HTMLDetailsElement>(
      '[data-testid="template-runtime-configuration"]'
    )
    if (configure && runtime && !runtime.open)
      await act(async () => {
        runtime.open = true
        runtime.dispatchEvent(new Event('toggle', { bubbles: true }))
      })
  }
  return { api, render, applied, project, onClose }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it('imports without loading runtime catalogs and leaves automatic execution disabled', async () => {
  const list = vi.fn(async () => {
    throw new Error('Runtime unavailable')
  })
  const { api, render, applied } = fixture({
    listTemplateAgentModels: list,
    renderDialog: () => null,
  })
  await render(undefined, false)
  expect(
    (
      container.querySelector(
        '[data-testid="template-runtime-configuration"]'
      ) as HTMLDetailsElement
    ).open
  ).toBe(false)
  expect(list).not.toHaveBeenCalled()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="template-bindings-apply"]')!.click()
  )
  expect(api.agents.create).toHaveBeenCalledTimes(6)
  for (const [, input] of vi.mocked(api.agents.create).mock.calls as [
    string,
    Record<string, unknown>,
  ][]) {
    expect(input.executionPolicy).toEqual({ mode: 'user_select' })
    expect(input.modelPolicy).toEqual({ mode: 'user_select' })
  }
  expect(api.automations.create).toHaveBeenCalledWith(
    'project',
    expect.objectContaining({ enabled: false })
  )
  expect(applied).toHaveBeenCalledOnce()
})

const selectableModel: RunnerModel = {
  runtime: 'codex',
  provider: 'company',
  model_id: 'chosen-model',
  source: 'native',
  label: 'Company model',
  account_label: 'Company',
  local_model_id: 'chosen-model',
  is_default: false,
}

it('hides the previous account model catalog while a new host is still loading', async () => {
  const first: ProjectAgentConfigurationHost = {
    renderDialog: () => null,
    listTemplateAgentModels: async () => ({ models: [selectableModel] }),
  }
  const second: ProjectAgentConfigurationHost = {
    renderDialog: () => null,
    listTemplateAgentModels: () => new Promise(() => {}),
  }
  const onChange = vi.fn()
  const draw = (host: ProjectAgentConfigurationHost) =>
    act(async () =>
      root.render(
        <TemplateModelSelection
          runtime="codex"
          configuration={{
            host,
            location: 'local',
            environmentId: 'fixture-device',
          }}
          locale="zh-CN"
          disabled={false}
          onChange={onChange}
        />
      )
    )
  await draw(first)
  expect(container.textContent).toContain('Company model')
  await draw(second)
  expect(container.textContent).not.toContain('Company model')
  expect(
    container.querySelector<HTMLSelectElement>('[data-testid="template-model-codex"]')!.disabled
  ).toBe(true)
})

it('does not reuse a selected model after switching the import host', async () => {
  const first: ProjectAgentConfigurationHost = {
    renderDialog: () => null,
    listTemplateAgentModels: async () => ({ models: [selectableModel] }),
  }
  const second: ProjectAgentConfigurationHost = {
    renderDialog: () => null,
    listTemplateAgentModels: () => new Promise(() => {}),
  }
  const { render } = fixture(first)
  await render()
  const select = container.querySelector<HTMLSelectElement>('[data-testid="template-model-codex"]')!
  await act(async () => {
    select.value = runnerModelKey(selectableModel)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const apply = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="template-bindings-apply"]')!
  expect(apply().disabled).toBe(false)
  await render(second)
  expect(apply().disabled).toBe(false)
  expect(container.textContent).not.toContain('Company model')
})

it('persists an optional visible model choice for every imported Agent without a default', async () => {
  const host: ProjectAgentConfigurationHost = {
    renderDialog: () => null,
    listTemplateAgentModels: vi.fn(async () => ({ models: [selectableModel] })),
  }
  const { api, render } = fixture(host)
  await render()
  const apply = container.querySelector<HTMLButtonElement>(
    '[data-testid="template-bindings-apply"]'
  )!
  expect(apply.disabled).toBe(false)
  expect(container.textContent).toContain('智能体使用的模型')
  expect(container.textContent).not.toContain('请先为当前执行环境设置默认模型')
  const select = container.querySelector<HTMLSelectElement>('[data-testid="template-model-codex"]')!
  await act(async () => {
    select.value = runnerModelKey(selectableModel)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(apply.disabled).toBe(false)
  await act(async () => apply.click())
  expect(api.agents.create).toHaveBeenCalled()
  for (const [, input] of api.agents.create.mock.calls as unknown as [
    string,
    Record<string, unknown>,
  ][]) {
    expect(input.modelPolicy).toEqual({
      mode: 'fixed',
      model: runnerModelIdentity(selectableModel),
    })
  }
})

it('shows a recoverable catalog failure while allowing deferred configuration', async () => {
  const list = vi
    .fn<NonNullable<ProjectAgentConfigurationHost['listTemplateAgentModels']>>()
    .mockRejectedValueOnce(new Error('internal failure'))
    .mockResolvedValueOnce({ models: [] })
    .mockResolvedValueOnce({ models: [selectableModel] })
  const { api, render } = fixture({
    renderDialog: () => null,
    listTemplateAgentModels: list,
  })
  await render()
  expect(container.textContent).toContain('模型列表加载失败')
  expect(container.textContent).not.toContain('internal failure')
  const refresh = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="template-model-refresh-codex"]')!
  await act(async () => refresh().click())
  expect(container.textContent).toContain('暂无可用模型')
  await act(async () => refresh().click())
  expect(container.textContent).toContain('Company model')
  expect(
    container.querySelector<HTMLButtonElement>('[data-testid="template-bindings-apply"]')!.disabled
  ).toBe(false)
  expect(api.agents.create).not.toHaveBeenCalled()
})

it.each([{ models: [] }, { models: [selectableModel] }])(
  'reports partial cloud failures without presenting them as an empty catalog',
  async ({ models }) => {
    const { render } = fixture({
      renderDialog: () => null,
      listTemplateAgentModels: async () => ({ models }),
      listTemplateCloudAgentModels: async () => {
        throw new Error('Cloud unavailable')
      },
    })
    await render()
    expect(container.textContent).toContain('云端模型暂时无法加载')
    expect(container.textContent).not.toContain('暂无可用模型')
    expect(
      container.querySelector<HTMLSelectElement>('[data-testid="template-model-codex"]')!.options
        .length
    ).toBe(models.length + 1)
  }
)

it('allows selecting native models and applying while the cloud catalog is still pending', async () => {
  const { render, api } = fixture({
    renderDialog: () => null,
    listTemplateAgentModels: async () => ({ models: [selectableModel] }),
    listTemplateCloudAgentModels: () => new Promise(() => {}),
  })
  await render()
  const select = container.querySelector<HTMLSelectElement>('[data-testid="template-model-codex"]')!
  expect(select.disabled).toBe(false)
  await act(async () => {
    select.value = runnerModelKey(selectableModel)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const apply = container.querySelector<HTMLButtonElement>(
    '[data-testid="template-bindings-apply"]'
  )!
  expect(apply.disabled).toBe(false)
  await act(async () => apply.click())
  expect(api.agents.create).toHaveBeenCalled()
})

it('keeps an explicitly cleared native default empty when the cloud request completes', async () => {
  let resolveCloud!: (models: RunnerModel[]) => void
  const host: ProjectAgentConfigurationHost = {
    renderDialog: () => null,
    listTemplateAgentModels: async () => ({
      models: [{ ...selectableModel, is_default: true }],
    }),
    listTemplateCloudAgentModels: () =>
      new Promise(resolve => {
        resolveCloud = resolve
      }),
  }
  const onChange = vi.fn()
  await act(async () =>
    root.render(
      <TemplateModelSelection
        runtime="codex"
        configuration={{
          host,
          location: 'local',
          environmentId: 'fixture-device',
        }}
        locale="zh-CN"
        disabled={false}
        onChange={onChange}
      />
    )
  )
  const select = container.querySelector<HTMLSelectElement>('[data-testid="template-model-codex"]')!
  expect(select.value).toBe(runnerModelKey(selectableModel))
  await act(async () => {
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => resolveCloud([]))
  expect(select.value).toBe('')
  expect(onChange).toHaveBeenLastCalledWith(undefined)
})

it('retains the displayed choice on refresh failure and supports deferred configuration', async () => {
  const list = vi
    .fn<NonNullable<ProjectAgentConfigurationHost['listTemplateAgentModels']>>()
    .mockResolvedValueOnce({ models: [selectableModel] })
    .mockRejectedValueOnce(new Error('Network unavailable'))
    .mockResolvedValueOnce({ models: [selectableModel] })
  const { render, api } = fixture({
    renderDialog: () => null,
    listTemplateAgentModels: list,
  })
  await render()
  const select = container.querySelector<HTMLSelectElement>('[data-testid="template-model-codex"]')!
  const apply = container.querySelector<HTMLButtonElement>(
    '[data-testid="template-bindings-apply"]'
  )!
  await act(async () => {
    select.value = runnerModelKey(selectableModel)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(apply.disabled).toBe(false)
  const refresh = container.querySelector<HTMLButtonElement>(
    '[data-testid="template-model-refresh-codex"]'
  )!
  await act(async () => refresh.click())
  expect(select.value).toBe(runnerModelKey(selectableModel))
  expect(select.disabled).toBe(true)
  expect(apply.disabled).toBe(false)
  expect(api.agents.create).not.toHaveBeenCalled()
  await act(async () => refresh.click())
  expect(select.disabled).toBe(false)
  expect(apply.disabled).toBe(false)
})

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

function applyButton() {
  return container.querySelector<HTMLButtonElement>('[data-testid="template-bindings-apply"]')!
}

async function renameDraft(name: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="template-group-name-main"]'
    )!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it.each(['project', 'api'] as const)(
  'preserves the current names and candidates when old recovery completes after a %s change',
  async change => {
    const { api, render, project } = fixture()
    const nextApi = change === 'api' ? fixture().api : api
    const projectId = change === 'project' ? 'project-b' : 'project'
    const creation = deferred<Awaited<ReturnType<typeof api.projects.createCollaborationGroup>>>()
    const currentGroup = { id: 'b-group', name: 'B existing' } as CollaborationGroup
    const oldGroup = { id: 'a-group', name: 'A existing' } as CollaborationGroup
    api.projects.createCollaborationGroup.mockReturnValueOnce(creation.promise)
    api.projects.listCollaborationGroups.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    api.members.list.mockResolvedValueOnce([{ user_id: 7, user_name: 'A owner' }])
    await render()
    await act(async () => applyButton().click())
    expect(api.projects.createCollaborationGroup).toHaveBeenCalledOnce()
    nextApi.projects.get.mockResolvedValue({ ...project, id: projectId })
    nextApi.projects.listCollaborationGroups.mockResolvedValueOnce([currentGroup])
    nextApi.members.list.mockResolvedValue([{ user_id: 7, user_name: 'B owner' }])
    api.projects.listCollaborationGroups.mockResolvedValue([oldGroup])
    await render(undefined, false, {
      api: nextApi as unknown as SharedWorkspaceApi,
      projectId,
    })
    await renameDraft('B existing')
    await act(async () => creation.reject(new TypeError('Failed to fetch')))
    const choices = container.querySelector('select')!.textContent!
    expect(choices).toContain('B owner')
    expect(choices).not.toContain('A owner')
    const calls = nextApi.projects.createCollaborationGroup.mock.calls.length
    await act(async () => applyButton().click())
    expect(nextApi.projects.createCollaborationGroup).toHaveBeenCalledTimes(calls)
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('已有这个小组名称')
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="template-group-name-main"]')!.value
    ).toBe('B existing')
  }
)

it.each(['project', 'api', 'unmount'] as const)(
  'ignores an old successful final refresh after a %s change',
  async change => {
    const { api, render, project, applied, onClose } = fixture()
    const finalRefresh = deferred<typeof project>()
    api.projects.get
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project)
      .mockReturnValueOnce(finalRefresh.promise)
    await render()
    await act(async () => applyButton().click())
    expect(api.projects.update).toHaveBeenCalledOnce()
    expect(api.projects.get).toHaveBeenCalledTimes(3)
    if (change === 'unmount') {
      await act(async () => root.render(null))
    } else {
      const nextApi = change === 'api' ? fixture().api : api
      const projectId = change === 'project' ? 'project-b' : 'project'
      nextApi.projects.get.mockResolvedValue({ ...project, id: projectId })
      nextApi.members.list.mockResolvedValue([{ user_id: 7, user_name: 'B owner' }])
      await render(undefined, false, {
        api: nextApi as unknown as SharedWorkspaceApi,
        projectId,
      })
      expect(container.querySelector('select')!.textContent).toContain('B owner')
    }
    await act(async () => finalRefresh.resolve(project))
    expect(applied).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  }
)

it('does not publish a pending initial load after the dialog is closed', async () => {
  const { api, render, project, onClose } = fixture()
  const load = deferred<typeof project>()
  api.projects.get.mockReturnValueOnce(load.promise)
  await render()
  await click('collaboration-template-close')
  expect(onClose).toHaveBeenCalledOnce()
  await act(async () => load.resolve(project))
  expect(api.members.list).not.toHaveBeenCalled()
  expect(container.querySelector('[data-testid="template-bindings-apply"]')).toBeNull()
})

it('preserves the draft and member binding after a rejected member configuration', async () => {
  const { api, render, applied } = fixture()
  api.projects.createCollaborationGroup.mockRejectedValue(
    Object.assign(new Error('rejected'), { status: 422, detail: 'member must be a Developer' })
  )
  api.projects.listCollaborationGroups
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 'existing', name: 'Discovered group' } as CollaborationGroup])
  await render()
  await renameDraft('Current draft')
  const before = container.querySelector<HTMLSelectElement>('select')!.value
  await act(async () => applyButton().click())
  expect(
    container.querySelector<HTMLInputElement>('[data-testid="template-group-name-main"]')!.value
  ).toBe('Current draft')
  expect(container.querySelector<HTMLSelectElement>('select')!.value).toBe(before)
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('成员')
  expect(applyButton().disabled).toBe(false)
  expect(api.projects.listCollaborationGroups).toHaveBeenCalledTimes(3)
  expect(applied).not.toHaveBeenCalled()
  await renameDraft('Discovered group')
  await act(async () => applyButton().click())
  expect(api.projects.createCollaborationGroup).toHaveBeenCalledOnce()
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('已有这个小组名称')
})

it('keeps unknown writes blocked across empty rechecks and reports a later observed group', async () => {
  const { api, render } = fixture()
  api.projects.createCollaborationGroup.mockRejectedValue(new TypeError('Failed to fetch'))
  api.projects.listCollaborationGroups
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 'persisted', name: 'Retained draft' } as CollaborationGroup])
  await render()
  await renameDraft('Retained draft')
  await act(async () => applyButton().click())
  expect(applyButton().disabled).toBe(true)
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('尚不能确认')
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="template-bindings-recheck"]')!.click()
  )
  expect(api.projects.createCollaborationGroup).toHaveBeenCalledOnce()
  expect(applyButton().disabled).toBe(true)
  expect(
    container.querySelector<HTMLInputElement>('[data-testid="template-group-name-main"]')!.value
  ).toBe('Retained draft')
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('尚不能确认')
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="template-bindings-recheck"]')!.click()
  )
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    '发现同名的新小组：Retained draft'
  )
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    '尚不能确认是否由本次请求创建'
  )
  expect(container.querySelector('[role="alert"]')!.textContent).not.toContain('已创建小组')
  expect(applyButton().disabled).toBe(true)
  expect(container.querySelector('[data-testid="template-bindings-recheck"]')).not.toBeNull()
  expect(api.projects.createCollaborationGroup).toHaveBeenCalledOnce()
})

it('keeps a same-name observation unconfirmed after a lost response and prevents another import', async () => {
  const { api, render } = fixture()
  api.projects.createCollaborationGroup.mockRejectedValue(new TypeError('Failed to fetch'))
  api.projects.listCollaborationGroups
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 'persisted', name: '产品全流程小组' } as CollaborationGroup])
  await render()
  await act(async () => applyButton().click())
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    '发现同名的新小组：产品全流程小组'
  )
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    '尚不能确认是否由本次请求创建'
  )
  expect(container.querySelector('[role="alert"]')!.textContent).not.toContain('已创建小组')
  expect(container.querySelector('[data-testid="template-bindings-recheck"]')).not.toBeNull()
  expect(applyButton().disabled).toBe(true)
  await act(async () => applyButton().click())
  expect(api.projects.createCollaborationGroup).toHaveBeenCalledOnce()
})

it('shows a server configuration error together with the saved group and keeps the draft visible', async () => {
  const { api, render } = fixture()
  api.projects.update.mockRejectedValue(Object.assign(new Error('server failed'), { status: 500 }))
  await render()
  await act(async () => applyButton().click())
  const alert = container.querySelector('[role="alert"]')!.textContent!
  expect(alert).toContain('服务端')
  expect(alert).toContain('已创建小组：产品全流程小组')
  expect(alert).not.toContain('检查连接')
  expect(container.querySelector('[data-testid="template-group-name-main"]')).not.toBeNull()
  expect(applyButton().disabled).toBe(true)
})

it('refreshes saved groups when the final project refresh fails after successful configuration', async () => {
  const { api, render, project, applied } = fixture()
  api.projects.get
    .mockResolvedValueOnce(project)
    .mockResolvedValueOnce(project)
    .mockRejectedValueOnce(Object.assign(new Error('server failed'), { status: 500 }))
  await render()
  await act(async () => applyButton().click())
  const alert = container.querySelector('[role="alert"]')!.textContent!
  expect(alert).toContain('服务端')
  expect(alert).toContain('已创建小组：产品全流程小组')
  expect(api.projects.listCollaborationGroups).toHaveBeenCalledTimes(3)
  expect(api.projects.createCollaborationGroup).toHaveBeenCalledOnce()
  expect(api.projects.update).toHaveBeenCalledOnce()
  expect(applied).not.toHaveBeenCalled()
  expect(applyButton().disabled).toBe(true)
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
  expect(api.agents.create).not.toHaveBeenCalled()
  await act(async () => {
    select.value = '74'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(host.listTemplateAgentEnvironments).toHaveBeenCalledOnce()
  await click('template-bindings-apply')
  expect(api.agents.create).toHaveBeenCalledWith(
    'project',
    expect.objectContaining({
      executionPolicy: { mode: 'fixed', environment_id: '74' },
      modelPolicy: { mode: 'user_select' },
    })
  )
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

it('keeps an explicit non-default model when runtime configuration is collapsed and reopened', async () => {
  const other = {
    ...selectableModel,
    model_id: 'other',
    label: 'Other',
    is_default: true,
  }
  const { api, render } = fixture({
    renderDialog: () => null,
    listTemplateAgentModels: async () => ({ models: [other, selectableModel] }),
  })
  await render()
  const select = container.querySelector<HTMLSelectElement>('[data-testid="template-model-codex"]')!
  await act(async () => {
    select.value = runnerModelKey(selectableModel)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const disclosure = container.querySelector<HTMLDetailsElement>(
    '[data-testid="template-runtime-configuration"]'
  )!
  for (const open of [false, true])
    await act(async () => {
      disclosure.open = open
      disclosure.dispatchEvent(new Event('toggle', { bubbles: true }))
    })
  expect(container.querySelector('[data-testid="template-model-codex"]')).toBe(select)
  expect(select.value).toBe(runnerModelKey(selectableModel))
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="template-bindings-apply"]')!.click()
  )
  for (const [, input] of api.agents.create.mock.calls as unknown as [
    string,
    Record<string, unknown>,
  ][]) {
    expect(input.modelPolicy).toEqual({
      mode: 'fixed',
      model: runnerModelIdentity(selectableModel),
    })
  }
})
