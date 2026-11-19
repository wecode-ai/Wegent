// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type {
  SharedWorkspaceApi,
  WorkspaceAutomationExecutionCatalog,
  WorkspaceRuntimeProfile,
} from '../ports/SharedWorkspaceApi'
import { RuntimeConfigurationRevisionContext } from '../runtime-profile/context'
import { ProjectRuntimeSettings } from './ProjectRuntimeSettings'

const profile: WorkspaceRuntimeProfile = {
  id: 'profile-1',
  name: 'My cloud runtime',
  executionEnvironment: 'cloud',
  executionDeviceId: 'cloud-1',
  model: 'model-1',
  modelType: 'group',
  modelOptions: { weworkCloudModelNamespace: 'engineering' },
  status: 'active',
  version: 1,
}
let root: Root | null = null
let container: HTMLDivElement
const navigate = vi.fn()
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  vi.clearAllMocks()
})
function element<T extends HTMLElement>(name: string): T {
  const result = container.querySelector<T>(`[data-testid="project-runtime-${name}"]`)
  if (!result) throw new Error(`Missing control ${name}`)
  return result
}
async function click(name: string) {
  await act(async () => element(name).click())
}
async function change(name: string, value: string) {
  await act(async () => {
    const target = element<HTMLInputElement | HTMLSelectElement>(name)
    if (target instanceof HTMLInputElement) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value)
      target.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      target.value = value
      target.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
}
function runtimeCatalog(
  profiles: WorkspaceRuntimeProfile[] = [profile],
  noDevices = false
): WorkspaceAutomationExecutionCatalog {
  return {
    environments: noDevices
      ? []
      : [
          {
            deviceId: 'cloud-1',
            label: 'Cloud',
            executionEnvironment: 'cloud',
          },
        ],
    models: [
      {
        name: 'native',
        label: 'Runtime native',
        type: 'runtime',
        options: {},
      },
      {
        name: 'model-1',
        label: 'Group model',
        type: 'group',
        options: profile.modelOptions,
      },
    ],
    runtimeProfiles: profiles,
    plugins: [],
  }
}

async function showRuntime(api: SharedWorkspaceApi, projectId = 'project-1', revision = 0) {
  await act(async () =>
    root!.render(
      <RuntimeConfigurationRevisionContext.Provider value={revision}>
        <ProjectRuntimeSettings
          api={api}
          projectId={projectId}
          translate={createCollaborationTranslator('zh-CN')}
          onConfigureEnvironments={navigate}
        />
      </RuntimeConfigurationRevisionContext.Provider>
    )
  )
}

async function render({
  profiles = [profile],
  defaultId = null,
  noDevices = false,
  failedSave = false,
}: {
  profiles?: WorkspaceRuntimeProfile[]
  defaultId?: string | null
  noDevices?: boolean
  failedSave?: boolean
} = {}) {
  const setDefault = vi.fn().mockResolvedValue({
    projectId: 'project-1',
    runtimeProfileId: 'profile-1',
    userId: 1,
  })
  if (failedSave) setDefault.mockRejectedValueOnce(new Error('Could not save binding'))
  const api = {
    automationExecutionCatalog: {
      load: vi.fn(async () => runtimeCatalog(profiles, noDevices)),
    },
    runtimeProfiles: {
      getProjectDefault: vi.fn(async () => ({ runtimeProfileId: defaultId })),
      create: vi.fn(async () => profile),
      setProjectDefault: setDefault,
    },
  } as unknown as SharedWorkspaceApi
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await showRuntime(api)
  return api
}

describe('ProjectRuntimeSettings', () => {
  it('shows missing configuration and saves an existing complete profile', async () => {
    const api = await render()
    expect(element('missing').textContent).toContain('AI 调度器无法启动')
    expect(element<HTMLButtonElement>('save').disabled).toBe(true)
    await change('profile', 'profile-1')
    await click('save')
    expect(api.runtimeProfiles.setProjectDefault).toHaveBeenCalledExactlyOnceWith(
      'project-1',
      'profile-1'
    )
    expect(element('current').textContent).toContain('model-1')
    expect(container.querySelector('[data-testid="project-runtime-missing"]')).toBeNull()
  })
  it('does not allow an incomplete profile to become the project default', async () => {
    await render({
      profiles: [{ ...profile, model: '' }],
      defaultId: 'profile-1',
    })
    expect(element('missing').textContent).toContain('设备和模型')
    expect(element<HTMLButtonElement>('save').disabled).toBe(true)
  })
  it('creates a cloud profile with the selected model identity and retries binding without duplicate creation', async () => {
    const api = await render({ profiles: [], failedSave: true })
    await click('create')
    await change('name', 'Cloud coordinator')
    await change('device', 'cloud-1')
    expect(element<HTMLSelectElement>('model').textContent).not.toContain('Runtime native')
    await change('model', '1')
    await click('save')
    expect(api.runtimeProfiles.create).toHaveBeenCalledExactlyOnceWith({
      name: 'Cloud coordinator',
      executionEnvironment: 'cloud',
      executionDeviceId: 'cloud-1',
      model: 'model-1',
      modelType: 'group',
      modelOptions: profile.modelOptions,
    })
    expect(container.textContent).toContain('Could not save binding')
    await click('save')
    expect(api.runtimeProfiles.create).toHaveBeenCalledTimes(1)
    expect(element('current').textContent).toContain('model-1')
  })
  it('provides a working environment configuration entry when no device is available', async () => {
    await render({ noDevices: true })
    await click('create')
    await click('configure-environments')
    expect(navigate).toHaveBeenCalledOnce()
    expect(element<HTMLButtonElement>('save').disabled).toBe(true)
  })
})

it.each(['project', 'api'] as const)('ignores a pending catalog after switching %s', async kind => {
  const api = await render({ defaultId: profile.id })
  let finish!: (catalog: WorkspaceAutomationExecutionCatalog) => void
  const pending = new Promise<WorkspaceAutomationExecutionCatalog>(resolve => {
    finish = resolve
  })
  const oldApi =
    kind === 'api'
      ? {
          ...api,
          automationExecutionCatalog: {
            load: vi.fn().mockReturnValue(pending),
          },
        }
      : api
  if (kind === 'project')
    vi.mocked(api.automationExecutionCatalog!.load).mockReturnValueOnce(pending)
  await showRuntime(oldApi, kind === 'project' ? 'project-2' : 'project-1')
  const nextCatalog = runtimeCatalog([{ ...profile, name: 'New scope profile' }])
  const nextApi =
    kind === 'api'
      ? {
          ...api,
          automationExecutionCatalog: {
            load: vi.fn().mockResolvedValue(nextCatalog),
          },
        }
      : api
  if (kind === 'project')
    vi.mocked(api.automationExecutionCatalog!.load).mockResolvedValueOnce(nextCatalog)
  await showRuntime(nextApi, kind === 'project' ? 'project-3' : 'project-1')
  expect(element('current').textContent).toContain('New scope profile')
  await act(async () => finish(runtimeCatalog()))
  expect(element('current').textContent).toContain('New scope profile')
  expect(element('current').textContent).not.toContain('My cloud runtime')
})

it('retries a catalog load failure without retaining the prior API catalog', async () => {
  const api = await render({ defaultId: profile.id })
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('Catalog unavailable'))
    .mockResolvedValueOnce(runtimeCatalog())
  const replacement = { ...api, automationExecutionCatalog: { load } }
  await showRuntime(replacement)
  expect(container.textContent).toContain('Catalog unavailable')
  expect(container.querySelector('[data-testid="project-runtime-current"]')).toBeNull()
  await click('retry')
  expect(element('current').textContent).toContain(profile.name)
  expect(container.textContent).not.toContain('Catalog unavailable')
  expect(load).toHaveBeenCalledTimes(2)
})

it('reports an unsupported catalog without reading a project binding', async () => {
  const api = await render()
  vi.mocked(api.runtimeProfiles.getProjectDefault).mockClear()
  await showRuntime({ ...api, automationExecutionCatalog: undefined })
  expect(container.textContent).toContain('当前客户端不支持配置执行环境')
  expect(api.runtimeProfiles.getProjectDefault).not.toHaveBeenCalled()
})

it('keeps a created profile and binding when an older catalog refresh resolves later', async () => {
  const api = await render()
  const created = {
    ...profile,
    id: 'created-profile',
    name: 'Created profile',
  }
  let finishCreate!: (profile: WorkspaceRuntimeProfile) => void
  let finishRead!: (catalog: WorkspaceAutomationExecutionCatalog) => void
  vi.mocked(api.runtimeProfiles.create).mockReturnValueOnce(
    new Promise<WorkspaceRuntimeProfile>(resolve => {
      finishCreate = resolve
    })
  )
  vi.mocked(api.runtimeProfiles.setProjectDefault).mockResolvedValueOnce({
    projectId: 'project-1',
    userId: 1,
    runtimeProfileId: created.id,
  })
  await click('create')
  await change('name', created.name)
  await change('device', 'cloud-1')
  await change('model', '1')
  await act(async () => element('save').click())
  vi.mocked(api.automationExecutionCatalog!.load).mockReturnValueOnce(
    new Promise<WorkspaceAutomationExecutionCatalog>(resolve => {
      finishRead = resolve
    })
  )
  await showRuntime(api, 'project-1', 1)
  await act(async () => finishCreate(created))
  expect(element('current').textContent).toContain(created.name)
  await act(async () => finishRead(runtimeCatalog()))
  expect(element('current').textContent).toContain(created.name)
  expect(element<HTMLSelectElement>('profile').value).toBe(created.id)
  expect(api.runtimeProfiles.create).toHaveBeenCalledOnce()
  expect(api.runtimeProfiles.setProjectDefault).toHaveBeenCalledExactlyOnceWith(
    'project-1',
    created.id
  )
})

it('does not bind a profile created for a project that has already been left', async () => {
  const api = await render()
  let finishCreate!: (profile: WorkspaceRuntimeProfile) => void
  vi.mocked(api.runtimeProfiles.create).mockReturnValueOnce(
    new Promise<WorkspaceRuntimeProfile>(resolve => {
      finishCreate = resolve
    })
  )
  await click('create')
  await change('name', 'Old project profile')
  await change('device', 'cloud-1')
  await change('model', '1')
  await act(async () => element('save').click())
  await showRuntime(api, 'project-2')
  await act(async () =>
    finishCreate({
      ...profile,
      id: 'old-created-profile',
      name: 'Old project profile',
    })
  )
  expect(api.runtimeProfiles.setProjectDefault).not.toHaveBeenCalled()
  expect(element<HTMLSelectElement>('profile').value).toBe('')
  expect(element<HTMLSelectElement>('profile').disabled).toBe(false)
  expect(container.textContent).not.toContain('Old project profile')
})
