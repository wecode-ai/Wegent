import { sdkSelectValue, sdkSelectItems } from '../test/selectControl'
// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CollaborationLocale } from '../i18n'
import { templateMessages } from './messages'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import { builtinCollaborationTemplates } from './builtins'
import { ProjectTemplateApplyDialog } from './ProjectTemplateApplyDialog'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationExecutionEnvironment } from '../types'
import { runnerModelKey, runnerModelIdentity, type RunnerModel } from '../agent-form/runnerRouting'
import { TemplateModelSelection } from './TemplateModelSelection'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
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
      listCollaborationGroups: vi.fn(async () => []),
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
  const render = async (
    agentConfiguration = host,
    configure = true,
    locale: CollaborationLocale = 'zh-CN',
    projectId = 'project'
  ) => {
    await act(async () =>
      root.render(
        <ProjectTemplateApplyDialog
          api={api as unknown as SharedWorkspaceApi}
          projectId={projectId}
          document={document}
          locale={locale}
          currentUserId={7}
          agentConfiguration={agentConfiguration}
          onClose={() => {}}
          onApplied={applied}
        />
      )
    )
    const runtime = container.querySelector<HTMLElement>('[data-testid="template-bindings-toggle"]')
    if (configure && runtime?.getAttribute('aria-expanded') !== 'true')
      await act(async () => runtime?.click())
  }
  return { api, render, applied, project }
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
    container
      .querySelector('[data-testid="template-bindings-toggle"]')
      ?.getAttribute('aria-expanded') === 'true'
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
  expect(
    (
      await sdkSelectItems(
        container.querySelector<HTMLButtonElement>('[data-testid="template-model-codex"]')!
      )
    )
      .map(option => option.label)
      .join('\n')
  ).toContain('Company model')
  await draw(second)
  expect(container.textContent).not.toContain('Company model')
  expect(
    container.querySelector<HTMLButtonElement>('[data-testid="template-model-codex"]')!.disabled
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
  const select = container.querySelector<HTMLButtonElement>('[data-testid="template-model-codex"]')!
  await sdkSelectValue(select, runnerModelKey(selectableModel))
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
  const select = container.querySelector<HTMLButtonElement>('[data-testid="template-model-codex"]')!
  await sdkSelectValue(select, runnerModelKey(selectableModel))
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
  expect(
    (
      await sdkSelectItems(
        container.querySelector<HTMLButtonElement>('[data-testid="template-model-codex"]')!
      )
    )
      .map(option => option.label)
      .join('\n')
  ).toContain('Company model')
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
      (
        await sdkSelectItems(
          container.querySelector<HTMLButtonElement>('[data-testid="template-model-codex"]')!
        )
      ).length
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
  const select = container.querySelector<HTMLButtonElement>('[data-testid="template-model-codex"]')!
  expect(select.disabled).toBe(false)
  await sdkSelectValue(select, runnerModelKey(selectableModel))
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
  const select = container.querySelector<HTMLButtonElement>('[data-testid="template-model-codex"]')!
  expect(await sdkSelectValue(select)).toBe(runnerModelKey(selectableModel))
  await sdkSelectValue(select, '')
  await act(async () => resolveCloud([]))
  expect(await sdkSelectValue(select)).toBe('')
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
  const select = container.querySelector<HTMLButtonElement>('[data-testid="template-model-codex"]')!
  const apply = container.querySelector<HTMLButtonElement>(
    '[data-testid="template-bindings-apply"]'
  )!
  await sdkSelectValue(select, runnerModelKey(selectableModel))
  expect(apply.disabled).toBe(false)
  const refresh = container.querySelector<HTMLButtonElement>(
    '[data-testid="template-model-refresh-codex"]'
  )!
  await act(async () => refresh.click())
  expect(await sdkSelectValue(select)).toBe(runnerModelKey(selectableModel))
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
  const select = container.querySelector<HTMLElement>(
    '[data-testid="template-project-environment-select"]'
  )!
  expect([...(await sdkSelectItems(select))].map(option => option.value)).toEqual(['', '73', '74'])
  expect(api.agents.create).not.toHaveBeenCalled()
  await sdkSelectValue(select, '74')
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
    await sdkSelectValue(
      container.querySelector<HTMLElement>('[data-testid="template-project-environment-select"]')!
    )
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
  const select = container.querySelector<HTMLButtonElement>('[data-testid="template-model-codex"]')!
  await sdkSelectValue(select, runnerModelKey(selectableModel))
  const disclosure = container.querySelector<HTMLElement>(
    '[data-testid="template-runtime-configuration"]'
  )!
  for (const open of [false, true]) {
    const toggle = disclosure.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe(String(open))
  }
  expect(container.querySelector('[data-testid="template-model-codex"]')).toBe(select)
  expect(await sdkSelectValue(select)).toBe(runnerModelKey(selectableModel))
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

it('keeps binding drafts while changing locale without reloading project prerequisites', async () => {
  const { api, render } = fixture()
  await render()
  const name = container.querySelector<HTMLInputElement>('[data-testid^="template-group-name-"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      name,
      'My edited group'
    )
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await render(undefined, false, 'en')
  expect(api.projects.get).toHaveBeenCalledTimes(1)
  expect(api.members.list).toHaveBeenCalledTimes(1)
  expect(
    container.querySelector<HTMLInputElement>('[data-testid^="template-group-name-"]')?.value
  ).toBe('My edited group')
})

it('does not load candidates for a project detached while its permission read was pending', async () => {
  const { api, render, project } = fixture()
  let resolve!: (value: typeof project) => void
  const pending = new Promise<typeof project>(done => {
    resolve = done
  })
  api.projects.get.mockReturnValueOnce(pending)
  await render(undefined, false)
  expect(api.members.list).not.toHaveBeenCalled()
  await render(undefined, false, 'zh-CN', 'next-project')
  expect(api.members.list).toHaveBeenCalledExactlyOnceWith('next-project')
  await act(async () => resolve(project))
  expect(api.members.list).toHaveBeenCalledTimes(1)
})

it('localizes denied management access without loading candidates or retrying implicitly', async () => {
  const { api, render, project } = fixture()
  api.projects.get.mockResolvedValue({ ...project, access_role: 'Viewer' })
  await render(undefined, false)
  await render(undefined, false, 'en')
  expect(api.projects.get).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    templateMessages.en.manageRequired
  )
  expect(api.members.list).not.toHaveBeenCalled()
  expect(api.agents.list).not.toHaveBeenCalled()
  expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled()
})

it('does not apply the previous host environment while the new host catalog is pending', async () => {
  const first = environmentHost()
  const { render, api } = fixture(first)
  await render()
  const select = container.querySelector<HTMLSelectElement>(
    '[data-testid="template-project-environment-select"]'
  )!
  await act(async () => {
    select.value = '74'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  let resolve!: (value: CollaborationExecutionEnvironment[]) => void
  const pending = new Promise<CollaborationExecutionEnvironment[]>(done => {
    resolve = done
  })
  const second = { ...environmentHost(), listTemplateAgentEnvironments: vi.fn(() => pending) }
  await render(second, false)
  expect(
    container.querySelector<HTMLSelectElement>(
      '[data-testid="template-project-environment-select"]'
    )?.disabled
  ).toBe(true)
  await click('template-bindings-apply')
  expect(api.agents.create).toHaveBeenCalledWith(
    'project',
    expect.objectContaining({
      executionPolicy: { mode: 'user_select' },
    })
  )
  await act(async () => resolve([]))
})
