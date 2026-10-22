// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCollaborationTranslator } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationExecutionEnvironment, CollaborationProject } from '../types'
import { useExecutionEnvironmentList } from '../execution-environment/useExecutionEnvironmentList'
import { useDeviceCatalog } from '../platform/useDeviceCatalog'
import { ProjectExecutionEnvironments } from './ProjectExecutionEnvironments'

const device = {
  id: 'runner-1',
  device_id: 1,
  name: 'Project runner',
  status: 'online',
  kind: 'local_device',
  owner_type: 'user',
  owner_id: '1',
  owner_name: 'Owner',
  coding_tools: [],
} as CollaborationExecutionEnvironment
const project = {
  id: 'project-1',
  workspace_id: 'workspace-1',
  version: 1,
  access_role: 'Owner',
} as CollaborationProject
const translate = createCollaborationTranslator('zh-CN')
const prefix = 'collaboration-project-execution-environment'
let root: Root
let container: HTMLDivElement

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function apiFor(
  list: SharedWorkspaceApi['projects']['listExecutionEnvironments'] = vi.fn(async () => [device])
) {
  return {
    projects: { listExecutionEnvironments: list },
    workspaces: { listExecutionEnvironments: vi.fn(async () => []) },
    resources: {
      devices: { cloud: vi.fn(async () => []) },
      list: vi.fn(async () => ({ agents: [], execution_environments: [] })),
    },
    gitRepositories: { list: vi.fn(async () => []), listBranches: vi.fn(async () => []) },
  } as unknown as SharedWorkspaceApi
}

async function render(api: SharedWorkspaceApi, selectedProject = project) {
  if (!container) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () =>
    root.render(
      <ProjectExecutionEnvironments api={api} project={selectedProject} translate={translate} />
    )
  )
}

const element = (suffix: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${prefix}${suffix}"]`)

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = undefined!
})

describe('execution environment settings loading', () => {
  it('reuses the device page snapshot across scoped APIs without granting local placeholder IDs', async () => {
    const api = apiFor()
    const registered = { ...device, id: 'registered-22', device_id: 22, device_key: 'runtime-22' }
    const cloud = vi.fn(async () => [registered])
    api.resources!.devices = {
      local: vi.fn(async () => [{ ...device, device_key: 'runtime-22' }]),
      cloud,
    }
    function DevicePage() {
      const catalog = useDeviceCatalog(api, true)
      return <div>{catalog.items.map(item => item.id).join(',')}</div>
    }
    await render(api)
    await act(async () => root.render(<DevicePage />))
    expect(container.textContent).toBe('registered-22')
    const pending = deferred<CollaborationExecutionEnvironment[]>()
    cloud.mockImplementation(() => pending.promise)
    await render({
      ...api,
      projects: { ...api.projects },
      resources: { ...api.resources!, devices: { cloud } },
    })
    await act(async () => element('-add')!.click())
    expect(element('-candidate-22')).not.toBeNull()
    expect(element('-candidate-1')).toBeNull()
    expect(element('-picker-loading')).toBeNull()
    expect(api.resources!.list).not.toHaveBeenCalled()
    await act(async () => pending.resolve([]))
    expect(element('-candidate-22')).toBeNull()
  })

  it('uses local candidates for a local project even while cloud discovery cannot finish', async () => {
    const api = apiFor(vi.fn(async () => []))
    api.resources!.devices = {
      local: vi.fn(async () => [device]),
      cloud: vi.fn(() => new Promise(() => {})),
    }
    await render(api, { ...project, project_store: 'local' })
    await act(async () => element('-add')!.click())
    expect(element('-candidate-1')).not.toBeNull()
    expect(element('-picker-loading')).toBeNull()
    expect(api.resources!.devices.cloud).not.toHaveBeenCalled()
    expect(api.resources!.list).not.toHaveBeenCalled()
  })

  it('renders personal candidates before shared devices and does not reuse another account catalog', async () => {
    const api = apiFor(vi.fn(async () => []))
    const shared = deferred<CollaborationExecutionEnvironment[]>()
    api.workspaces!.listExecutionEnvironments = vi.fn(() => shared.promise)
    api.resources!.devices.cloud = vi.fn(async () => [device])
    await render(api)
    await act(async () => element('-add')!.click())
    expect(element('-candidate-1')).not.toBeNull()
    expect(element('-picker-loading')).toBeNull()
    await act(async () => shared.resolve([{ ...device, id: 'shared-2', device_id: 2 }]))
    expect(element('-candidate-2')).not.toBeNull()
    const nextSession = apiFor(vi.fn(async () => []))
    nextSession.resources!.devices.cloud = vi.fn(() => new Promise(() => {}))
    await render(nextSession)
    expect(element('-candidate-1')).toBeNull()
    expect(element('-candidate-2')).toBeNull()
    expect(element('-picker-loading')).not.toBeNull()
  })

  it('renders assigned runners independently and requests optional catalogs only when opened', async () => {
    const slow = deferred<CollaborationExecutionEnvironment[]>()
    const api = apiFor()
    api.workspaces!.listExecutionEnvironments = vi.fn(() => slow.promise)
    await render(api)
    expect(element('-1')?.textContent).toContain('Project runner')
    expect(element('-1')?.textContent).not.toContain('项目直接添加')
    expect(element('-loading')).toBeNull()
    expect(api.resources!.list).not.toHaveBeenCalled()
    expect(api.gitRepositories!.list).not.toHaveBeenCalled()
    await act(async () => element('-add')!.click())
    expect(api.resources!.devices.cloud).toHaveBeenCalledOnce()
    expect(api.resources!.list).not.toHaveBeenCalled()
    expect(element('-1')).not.toBeNull()
    expect(element('-picker-loading')).not.toBeNull()
    await act(async () => slow.resolve([device]))
    expect(element('-picker-loading')).toBeNull()
    expect(element('-1')?.textContent).toContain('空间共享')
  })

  it('shows an initial failure with retry without claiming that the device pool is empty', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('Access denied'))
      .mockResolvedValueOnce([device])
    const api = apiFor(list)
    await render(api)
    expect(element('s-error')?.textContent).toContain('Access denied')
    expect(element('-loading')).toBeNull()
    expect(container.textContent).not.toContain('尚未添加')
    await act(async () => element('-retry')!.click())
    expect(element('-1')).not.toBeNull()
    expect(element('s-error')).toBeNull()
  })

  it('keeps assigned runners visible when the optional candidate catalog fails and can retry it', async () => {
    const api = apiFor()
    const shared = deferred<CollaborationExecutionEnvironment[]>()
    api.workspaces!.listExecutionEnvironments = vi.fn(() => shared.promise)
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('Catalog unavailable'))
      .mockResolvedValueOnce([{ ...device, id: 'runner-2', device_id: 2 }])
    api.resources!.devices.cloud = list
    await render(api)
    await act(async () => element('-add')!.click())
    expect(element('-1')).not.toBeNull()
    expect(element('-picker-error')?.textContent).toContain('Catalog unavailable')
    expect(element('-picker')?.textContent).not.toContain('没有可添加')
    expect((element('-picker-retry') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => element('-picker-retry')!.click())
    expect(element('-picker-error')).toBeNull()
    expect(element('-candidate-2')).not.toBeNull()
    await act(async () => shared.resolve([]))
  })

  it('shows cached rows immediately on reopening and applies a successful empty refresh', async () => {
    const list = vi.fn(async () => [device])
    const api = apiFor(list)
    await render(api)
    await act(async () => root.render(null))
    const refresh = deferred<CollaborationExecutionEnvironment[]>()
    list.mockImplementation(() => refresh.promise)
    await render(api)
    expect(element('-1')).not.toBeNull()
    expect(element('-loading')).toBeNull()
    expect((element('-add') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => refresh.resolve([]))
    expect(element('-1')).toBeNull()
    expect(container.textContent).toContain('尚未添加')
  })

  it('preserves cached devices on refresh failure and exposes retry beside the list', async () => {
    const list = vi.fn(async () => [device])
    const api = apiFor(list)
    await render(api)
    await act(async () => root.render(null))
    list.mockRejectedValueOnce(new Error('Connection lost'))
    await render(api)
    expect(element('-1')).not.toBeNull()
    expect(element('s-error')?.textContent).toContain('Connection lost')
    list.mockResolvedValue([{ ...device, status: 'offline' }])
    await act(async () => element('-retry')!.click())
    expect(element('-1')?.textContent).toContain('离线')
    expect(element('s-error')).toBeNull()
  })

  it('isolates scopes and ignores late responses from another project', async () => {
    const old = deferred<CollaborationExecutionEnvironment[]>()
    const list = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([{ ...device, name: 'Second project' }])
    const api = apiFor(list)
    await render(api)
    expect(element('-loading')).not.toBeNull()
    await render(api, { ...project, id: 'project-2' })
    await act(async () => old.resolve([device]))
    expect(container.textContent).toContain('Second project')
    expect(container.textContent).not.toContain('Project runner')
    const nextSession = apiFor(vi.fn(() => new Promise(() => {})))
    await render(nextSession)
    expect(container.textContent).not.toContain('Second project')
    expect(element('-loading')).not.toBeNull()
  })

  it('does not fetch again when only the translation callback changes', async () => {
    const list = vi.fn(async () => [device])
    const api = apiFor(list)
    await render(api)
    await act(async () =>
      root.render(
        <ProjectExecutionEnvironments
          api={api}
          project={project}
          translate={createCollaborationTranslator('en')}
        />
      )
    )
    expect(list).toHaveBeenCalledOnce()
    expect(element('-1')).not.toBeNull()
  })

  it('deduplicates concurrent subscribers and keeps successful edits ahead of old reads', async () => {
    const response = deferred<CollaborationExecutionEnvironment[]>()
    const list = vi.fn(() => response.promise)
    const api = apiFor(list)
    function Probe() {
      const state = useExecutionEnvironmentList(api, 'project', 'project-1')
      return (
        <button data-testid="add-runner" onClick={() => state.update(() => [device])}>
          {state.items?.map(item => item.name).join(',') ?? 'pending'}
        </button>
      )
    }
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () =>
      root.render(
        <>
          <Probe />
          <Probe />
        </>
      )
    )
    expect(list).toHaveBeenCalledOnce()
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    await act(async () => response.resolve([]))
    expect(container.textContent).toBe('Project runnerProject runner')
  })
})
