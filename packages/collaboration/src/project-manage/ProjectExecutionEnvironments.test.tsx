// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createCollaborationTranslator,
  type CollaborationLocale,
} from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type {
  CollaborationExecutionEnvironment,
  CollaborationProject,
} from '../types'
import { ProjectExecutionEnvironments } from './ProjectExecutionEnvironments'

const project: CollaborationProject = {
  id: 'project-1',
  workspace_id: 'workspace-1',
  public_id: 'project-public-1',
  project_key: 'PRJ',
  name: 'Project',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  access_role: 'Owner',
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-09-14T00:00:00Z',
  updated_at: '2026-09-14T00:00:00Z',
}

function environment(
  deviceId: number,
  name: string,
  status: CollaborationExecutionEnvironment['status'],
): CollaborationExecutionEnvironment {
  return {
    id: `environment-${deviceId}`,
    device_id: deviceId,
    device_key: `device-${deviceId}`,
    name,
    kind: 'local_device',
    coding_tools: ['codex'],
    owner_type: 'user',
    owner_id: '1',
    owner_name: 'Owner',
    status,
    updated_at: '2026-09-14T00:00:00Z',
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

const prefix = 'collaboration-project-execution-environment'

function element<T extends HTMLElement>(suffix: string): T {
  const result = container?.querySelector<T>(
    `[data-testid="${prefix}${suffix}"]`,
  )
  if (!result) throw new Error(`Missing element: ${suffix}`)
  return result
}

async function change(suffix: string, value: string) {
  await act(async () => {
    const select = element<HTMLSelectElement>(suffix)
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function options() {
  return [...element<HTMLSelectElement>('-select').options].map(
    (option) => option.textContent,
  )
}

async function render({
  assigned = [],
  role = 'Owner',
  locale = 'zh-CN',
}: {
  assigned?: CollaborationExecutionEnvironment[]
  role?: CollaborationProject['access_role']
  locale?: CollaborationLocale
} = {}) {
  const online = environment(21, 'Personal online', 'online')
  const offline = environment(22, 'Personal offline', 'offline')
  const shared = environment(23, 'Shared online', 'online')
  const failed = environment(24, 'Shared error', 'error')
  const preparing = environment(25, 'Shared preparing', 'provisioning')
  const api = {
    projects: {
      listExecutionEnvironments: vi.fn(async () => assigned),
      addExecutionEnvironment: vi.fn(async () => offline),
    },
    resources: {
      list: vi.fn(async () => ({
        agents: [],
        execution_environments: [online, offline, shared],
      })),
    },
    workspaces: {
      listExecutionEnvironments: vi.fn(async () => [shared, failed, preparing]),
    },
  } as unknown as SharedWorkspaceApi
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <ProjectExecutionEnvironments
        api={api}
        project={{ ...project, access_role: role }}
        translate={createCollaborationTranslator(locale)}
      />,
    )
  })
  return api
}

describe('ProjectExecutionEnvironments', () => {
  it('labels all device statuses and deduplicates personal and shared resources', async () => {
    await render()

    expect(options()).toEqual([
      '选择执行环境',
      'Personal online · 在线 · 我的资源',
      'Personal offline · 离线 · 我的资源',
      'Shared online · 在线 · 空间共享',
      'Shared error · 异常 · 空间共享',
      'Shared preparing · 准备中 · 空间共享',
    ])
  })

  it.each([
    ['online', ['21', '23']],
    ['offline', ['22']],
    ['error', ['24']],
    ['provisioning', ['25']],
  ])(
    'filters candidates by %s and restores all statuses',
    async (status, deviceIds) => {
      await render()
      await change('-status-filter', status)

      expect(
        [...element<HTMLSelectElement>('-select').options]
          .slice(1)
          .map((option) => option.value),
      ).toEqual(deviceIds)

      await change('-status-filter', 'all')
      expect(options()).toHaveLength(6)
    },
  )

  it('clears hidden selection and keeps the filter usable when no candidates match', async () => {
    const api = await render({
      assigned: [environment(22, 'Assigned offline', 'offline')],
    })
    await change('-select', '21')
    expect(element<HTMLButtonElement>('-add').disabled).toBe(false)

    await change('-status-filter', 'offline')

    expect(element<HTMLSelectElement>('-select').value).toBe('')
    expect(element<HTMLSelectElement>('-select').disabled).toBe(true)
    expect(options()).toEqual(['没有符合当前状态的执行环境'])
    expect(element<HTMLButtonElement>('-add').disabled).toBe(true)
    expect(api.projects.addExecutionEnvironment).not.toHaveBeenCalled()

    await change('-status-filter', 'online')
    expect(element<HTMLSelectElement>('-select').disabled).toBe(false)
    expect(element<HTMLButtonElement>('-add').disabled).toBe(true)
    expect(container?.querySelector('[role="status"]')?.textContent).toBe(
      '没有符合当前状态的执行环境',
    )
  })

  it('adds the selected offline device and removes it from candidates', async () => {
    const api = await render()
    await change('-status-filter', 'offline')
    await change('-select', '22')
    await act(async () => element<HTMLButtonElement>('-add').click())

    expect(
      api.projects.addExecutionEnvironment,
    ).toHaveBeenCalledExactlyOnceWith('project-1', 22)
    expect(element('-22').textContent).toContain('Personal offline')
    expect(element('-22').textContent).toContain('离线')
    expect(element<HTMLSelectElement>('-select').value).toBe('')
    expect(element<HTMLButtonElement>('-add').disabled).toBe(true)
  })

  it('lets read-only members filter assigned devices without management controls', async () => {
    await render({
      role: 'Reporter',
      assigned: [
        environment(21, 'Assigned online', 'online'),
        environment(22, 'Assigned offline', 'offline'),
        environment(24, 'Assigned error', 'error'),
      ],
    })
    expect(element('-24').textContent).toContain('异常')
    expect(container?.querySelector(`[data-testid="${prefix}-add"]`)).toBeNull()
    expect(
      container?.querySelector(`[data-testid^="${prefix}-remove-"]`),
    ).toBeNull()

    await change('-status-filter', 'online')
    expect(element('-21').textContent).toContain('Assigned online')
    expect(container?.querySelector(`[data-testid="${prefix}-22"]`)).toBeNull()

    await change('-status-filter', 'all')
    expect(element('-22').textContent).toContain('Assigned offline')
  })

  it('localizes status labels and filters in English', async () => {
    await render({ locale: 'en' })
    expect(options()).toContain('Personal offline · Offline · My resources')
    expect(options()).toContain(
      'Shared preparing · Preparing · Shared by workspace',
    )
    expect(
      [...element<HTMLSelectElement>('-status-filter').options].map(
        (option) => option.textContent,
      ),
    ).toEqual(['All statuses', 'Online', 'Offline', 'Preparing', 'Error'])
  })
})
