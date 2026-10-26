// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

import { createCollaborationTranslator } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationExecutionEnvironment, CollaborationProject } from '../types'
import { ProjectDeviceAccessSettings } from './ProjectDeviceAccessSettings'

let container: HTMLDivElement
let root: Root
const environment = {
  device_id: 21,
  owner_type: 'user',
  owner_id: '1',
  can_manage_access: true,
  project_version: 3,
  use_access: { scope: 'project', member_ids: [] },
} as CollaborationExecutionEnvironment
const plan = {
  affected_execution_count: 2,
  affected_agent_count: 1,
  confirmation_token: 'reviewed',
}
const updated = { id: '100', version: 4 } as CollaborationProject
const element = <T extends HTMLElement = HTMLElement>(suffix: string) =>
  container.querySelector<T>(`[data-testid="project-device-access-21-${suffix}"]`)!
const click = async (suffix: string) => {
  await act(async () => element(suffix).click())
}
const select = async (scope: string) => {
  await act(async () => {
    element<HTMLSelectElement>('scope').value = scope
    element('scope').dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function setup(overrides: Partial<CollaborationExecutionEnvironment> = {}) {
  const update = vi
    .fn()
    .mockResolvedValueOnce({ ...updated, device_access_preview: plan })
    .mockResolvedValue(updated)
  const list = vi.fn().mockResolvedValue([
    { user_id: 1, user_name: 'Owner', role: 'Owner' },
    { user_id: 2, user_name: 'Developer', role: 'Developer' },
    { user_id: 3, user_name: 'Viewer', role: 'Viewer' },
    { user_id: 4, user_name: 'Reporter', role: 'Reporter' },
  ])
  const onChanged = vi.fn(async () => {})
  const onReload = vi.fn(async () => {})
  const api = { projects: { update }, members: { list } } as unknown as SharedWorkspaceApi
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const render = async (row = { ...environment, ...overrides }) => {
    await act(async () =>
      root.render(
        <ProjectDeviceAccessSettings
          api={api}
          projectId="100"
          environment={row}
          translate={createCollaborationTranslator('zh-CN')}
          onChanged={onChanged}
          onReload={onReload}
        />
      )
    )
  }
  await render()
  return { update, list, onChanged, onReload, render }
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it('requires an explicit confirmation before cancelling affected work', async () => {
  const { update, onChanged } = await setup()
  await click('edit')
  await select('owner')
  await click('save')
  expect(update).toHaveBeenCalledExactlyOnceWith('100', {
    version: 3,
    deviceAccessChange: { deviceId: 21, scope: 'owner', memberIds: [], previewOnly: true },
  })
  expect(element('impact').textContent).toContain('1 个智能体的 2 项任务')
  expect(element('impact').textContent).toContain('等待设备确认')
  expect(onChanged).not.toHaveBeenCalled()
  await click('save')
  expect(update).toHaveBeenLastCalledWith('100', {
    version: 3,
    deviceAccessChange: {
      deviceId: 21,
      scope: 'owner',
      memberIds: [],
      confirmationToken: 'reviewed',
    },
  })
  expect(onChanged).toHaveBeenCalledExactlyOnceWith(updated)
  expect(container.textContent).toContain('使用权限已保存')
})

it('discards the impact confirmation when its policy changes', async () => {
  const { update } = await setup()
  await click('edit')
  await select('owner')
  await click('save')
  await select('project')
  expect(element('impact')).toBeNull()
  await click('cancel')
  expect(update).toHaveBeenCalledTimes(1)
})

it('only offers current executable members and previews their exact selection', async () => {
  const { update } = await setup()
  await click('edit')
  await select('members')
  expect(element('member-1')).toBeNull()
  expect(element('member-3')).toBeNull()
  expect(element('member-4')).toBeNull()
  expect(element<HTMLButtonElement>('save').disabled).toBe(true)
  await click('member-2')
  await click('save')
  expect(update).toHaveBeenCalledWith('100', {
    version: 3,
    deviceAccessChange: { deviceId: 21, scope: 'members', memberIds: [2], previewOnly: true },
  })
})

it('applies a confirmed preview with no affected work without an extra confirmation', async () => {
  const { update, onChanged } = await setup()
  update
    .mockReset()
    .mockResolvedValueOnce({
      ...updated,
      device_access_preview: { ...plan, affected_execution_count: 0 },
    })
    .mockResolvedValue(updated)
  await click('edit')
  await select('owner')
  await click('save')
  expect(update).toHaveBeenCalledTimes(2)
  expect(onChanged).toHaveBeenCalledWith(updated)
})

it('offers reload after a rejected update and blocks a stale draft', async () => {
  const { update, onChanged, onReload, render } = await setup()
  update.mockReset().mockRejectedValue(new Error('409'))
  await click('edit')
  await click('save')
  expect(onChanged).not.toHaveBeenCalled()
  expect(container.textContent).toContain('权限保存失败')
  await render({ ...environment, project_version: 4 })
  expect(element<HTMLButtonElement>('save').disabled).toBe(true)
  await click('reload')
  expect(onReload).toHaveBeenCalledOnce()
})

it('shows a read-only scope for a member who does not own the device', async () => {
  const { update } = await setup({
    can_manage_access: false,
    unavailable_reason: 'device_use_not_allowed',
  })
  expect(element('edit')).toBeNull()
  expect(container.textContent).toContain('项目可执行成员')
  expect(container.textContent).toContain('当前账号无使用权限')
  expect(update).not.toHaveBeenCalled()
})
