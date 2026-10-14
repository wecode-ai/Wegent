// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCollaborationTranslator, type CollaborationLocale } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationExecutionEnvironment, CollaborationProject } from '../types'
import { ProjectExecutionEnvironments } from './ProjectExecutionEnvironments'

const device: CollaborationExecutionEnvironment = {
  id: 'personal-21',
  device_id: 21,
  device_key: 'runner-21',
  name: 'Personal runner',
  kind: 'local_device',
  status: 'online',
  owner_type: 'user',
  owner_id: '1',
  owner_name: 'Owner',
  coding_tools: ['codex'],
  updated_at: '2026-10-12T00:00:00Z',
}
const sharedDevice = { ...device, id: 'workspace-grant-21' }
const assignedDevice = { ...device, id: 'project-grant-21' }
const project = {
  id: 'project-1',
  workspace_id: 'workspace-1',
  version: 1,
  access_role: 'Owner',
  project_store: 'backend',
} as CollaborationProject
const prefix = 'collaboration-project-execution-environment'
let container: HTMLDivElement
let root: Root

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}

const element = (suffix: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${prefix}${suffix}"]`)
const candidate = () => element('-candidate-21') as HTMLButtonElement
const click = async (target: HTMLElement) => {
  await act(async () => target.click())
}

async function setup({
  shared = [] as CollaborationExecutionEnvironment[],
  listShared,
  locale = 'zh-CN',
  projectStore = 'backend',
}: {
  shared?: CollaborationExecutionEnvironment[]
  listShared?: () => Promise<CollaborationExecutionEnvironment[]>
  locale?: CollaborationLocale
  projectStore?: CollaborationProject['project_store']
} = {}) {
  const workspaces = {
    listExecutionEnvironments: vi.fn(listShared ?? (async () => shared)),
    addExecutionEnvironment: vi.fn(async () => sharedDevice),
  }
  const projects = {
    listExecutionEnvironments: vi.fn(async () => []),
    addExecutionEnvironment: vi.fn(async () => assignedDevice),
  }
  const resources = {
    devices: {
      cloud: vi.fn(async () => [device]),
      local: vi.fn(async () => [device]),
    },
  }
  const api = {
    workspaces,
    projects,
    resources,
  } as unknown as SharedWorkspaceApi
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <ProjectExecutionEnvironments
        api={api}
        project={{ ...project, project_store: projectStore }}
        translate={createCollaborationTranslator(locale)}
      />
    )
  })
  await click(element('-add')!)
  return { api, workspaces, projects, resources }
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

describe('project environment sharing', () => {
  it('explains the shared scope and completes sharing before project authorization', async () => {
    const { workspaces, projects } = await setup()
    const sharing = deferred<typeof sharedDevice>()
    workspaces.addExecutionEnvironment.mockImplementation(() => sharing.promise)
    expect(candidate().textContent).toBe('共享并添加')
    const hint = element('-share-hint-21')!
    expect(hint.textContent).toContain('空间成员可为其他项目授权使用')
    expect(hint.textContent).toContain('仍使用此环境的账号和额度')
    expect(candidate().getAttribute('aria-describedby')).toBe(hint.id)

    await click(candidate())
    expect(workspaces.addExecutionEnvironment).toHaveBeenCalledExactlyOnceWith('workspace-1', {
      deviceId: 21,
    })
    expect(projects.addExecutionEnvironment).not.toHaveBeenCalled()
    expect(candidate().disabled).toBe(true)

    await act(async () => sharing.resolve(sharedDevice))
    expect(projects.addExecutionEnvironment).toHaveBeenCalledExactlyOnceWith('project-1', 21)
    expect(element('-21')?.textContent).toContain('空间共享')
    expect(element('-picker')).toBeNull()
    expect(sharedDevice.owner_id).toBe('1')
  })

  it('directly authorizes an already shared environment without broadening access again', async () => {
    const { workspaces, projects } = await setup({ shared: [sharedDevice] })
    expect(candidate().textContent).toContain('添加')
    expect(candidate().textContent).not.toContain('共享并添加')
    expect(element('-share-hint-21')).toBeNull()
    await click(candidate())
    expect(workspaces.addExecutionEnvironment).not.toHaveBeenCalled()
    expect(projects.addExecutionEnvironment).toHaveBeenCalledOnce()
  })

  it('does not infer sharing status while the workspace catalog is pending', async () => {
    const catalog = deferred<CollaborationExecutionEnvironment[]>()
    const { workspaces, projects } = await setup({
      listShared: () => catalog.promise,
    })
    expect(candidate().disabled).toBe(true)
    expect(candidate().textContent).toBe('正在检查共享状态')
    await click(candidate())
    expect(workspaces.addExecutionEnvironment).not.toHaveBeenCalled()
    expect(projects.addExecutionEnvironment).not.toHaveBeenCalled()
    await act(async () => catalog.resolve([sharedDevice]))
    expect(candidate().disabled).toBe(false)
    await click(candidate())
    expect(workspaces.addExecutionEnvironment).not.toHaveBeenCalled()
    expect(projects.addExecutionEnvironment).toHaveBeenCalledOnce()
  })

  it('stops on a sharing permission failure and shows a localized actionable reason', async () => {
    const { workspaces, projects } = await setup()
    workspaces.addExecutionEnvironment.mockRejectedValueOnce(new Error('Insufficient permission'))
    await click(candidate())
    expect(projects.addExecutionEnvironment).not.toHaveBeenCalled()
    expect(element('s-error')?.textContent).toContain('共享环境失败：没有操作权限')
    expect(element('s-error')?.textContent).toContain('联系空间或项目管理员')
    expect(element('s-error')?.textContent).not.toContain('Insufficient permission')
    expect(candidate().disabled).toBe(false)
    expect(element('-21')).toBeNull()
  })

  it('keeps unknown sharing disabled after a catalog failure and recovers through retry', async () => {
    const listShared = vi
      .fn<() => Promise<CollaborationExecutionEnvironment[]>>()
      .mockRejectedValueOnce(new Error('Workspace not found'))
      .mockResolvedValueOnce([])
    const { workspaces, projects } = await setup({ listShared })
    expect(candidate().textContent).toBe('共享状态未确认')
    expect(candidate().disabled).toBe(true)
    expect(element('-picker-error')?.textContent).toContain('空间不存在或你已失去访问权限')
    await click(candidate())
    expect(workspaces.addExecutionEnvironment).not.toHaveBeenCalled()
    expect(projects.addExecutionEnvironment).not.toHaveBeenCalled()
    await click(element('-picker-retry')!)
    expect(candidate().disabled).toBe(false)
    expect(candidate().textContent).toBe('共享并添加')
    await click(candidate())
    expect(workspaces.addExecutionEnvironment).toHaveBeenCalledOnce()
    expect(projects.addExecutionEnvironment).toHaveBeenCalledOnce()
  })

  it('retains successful sharing after project failure and retries only project authorization', async () => {
    const { workspaces, projects } = await setup()
    projects.addExecutionEnvironment.mockRejectedValueOnce(new Error('Insufficient permission'))
    await click(candidate())
    expect(element('s-error')?.textContent).toContain('环境已共享到空间，但添加到项目失败')
    expect(element('s-error')?.textContent).toContain('请重试添加')
    expect(candidate().textContent).not.toContain('共享并添加')
    expect(element('-share-hint-21')).toBeNull()
    expect(element('-21')).toBeNull()
    await click(candidate())
    expect(workspaces.addExecutionEnvironment).toHaveBeenCalledOnce()
    expect(projects.addExecutionEnvironment).toHaveBeenCalledTimes(2)
    expect(element('-21')).not.toBeNull()
    expect(element('s-error')).toBeNull()
  })

  it('refreshes the workspace snapshot when a concurrently created share is reported', async () => {
    const { workspaces, projects } = await setup()
    workspaces.addExecutionEnvironment.mockRejectedValueOnce(
      new Error('Execution environment is already available in this Workspace')
    )
    await click(candidate())
    expect(projects.addExecutionEnvironment).not.toHaveBeenCalled()
    expect(element('s-error')?.textContent).toContain('环境已共享给空间，请刷新后重试添加')
    workspaces.listExecutionEnvironments.mockResolvedValueOnce([sharedDevice])
    await click(element('-retry')!)
    await click(candidate())
    expect(workspaces.addExecutionEnvironment).toHaveBeenCalledOnce()
    expect(projects.addExecutionEnvironment).toHaveBeenCalledOnce()
  })

  it('localizes revoked workspace access and rechecks sharing before retrying', async () => {
    const { workspaces, projects } = await setup({ shared: [sharedDevice] })
    projects.addExecutionEnvironment.mockRejectedValueOnce(
      new Error('Share the environment with this Workspace before authorizing it for a Project')
    )
    await click(candidate())
    expect(element('s-error')?.textContent).toContain('环境尚未共享给项目所属空间')
    expect(workspaces.addExecutionEnvironment).not.toHaveBeenCalled()
    workspaces.listExecutionEnvironments.mockResolvedValueOnce([])
    await click(element('-retry')!)
    expect(candidate().textContent).toBe('共享并添加')
    await click(candidate())
    expect(workspaces.addExecutionEnvironment).toHaveBeenCalledOnce()
    expect(projects.addExecutionEnvironment).toHaveBeenCalledTimes(2)
  })

  it('prevents two clicks in the same event turn from submitting twice', async () => {
    const { workspaces, projects } = await setup()
    const sharing = deferred<typeof sharedDevice>()
    workspaces.addExecutionEnvironment.mockImplementation(() => sharing.promise)
    await act(async () => {
      candidate().click()
      candidate().click()
    })
    expect(workspaces.addExecutionEnvironment).toHaveBeenCalledOnce()
    await act(async () => sharing.resolve(sharedDevice))
    expect(projects.addExecutionEnvironment).toHaveBeenCalledOnce()
  })

  it('keeps local project devices on their local authorization path', async () => {
    const { workspaces, projects, resources } = await setup({
      projectStore: 'local',
    })
    expect(candidate().textContent).not.toContain('共享并添加')
    await click(candidate())
    expect(resources.devices.cloud).not.toHaveBeenCalled()
    expect(resources.devices.local).toHaveBeenCalledOnce()
    expect(workspaces.addExecutionEnvironment).not.toHaveBeenCalled()
    expect(projects.addExecutionEnvironment).toHaveBeenCalledOnce()
  })

  it('renders the action, scope and permission errors in English for an English UI', async () => {
    const { workspaces } = await setup({ locale: 'en' })
    expect(candidate().textContent).toBe('Share and add')
    expect(element('-share-hint-21')?.textContent).toContain('Workspace members')
    workspaces.addExecutionEnvironment.mockRejectedValueOnce(new Error('Insufficient permission'))
    await click(candidate())
    expect(element('s-error')?.textContent).toContain('You do not have permission')
  })
})
