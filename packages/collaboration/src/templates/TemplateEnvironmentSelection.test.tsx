// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TemplateEnvironmentSelection } from './TemplateEnvironmentSelection'
import type { CollaborationExecutionEnvironment } from '../types'

it('starts collapsed and only offers online usable devices while preserving optional creation', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onChange = vi.fn()
  const device: CollaborationExecutionEnvironment = {
    id: '1',
    device_id: 1,
    name: 'Online Mac',
    kind: 'local_device',
    coding_tools: [],
    owner_type: 'user',
    owner_id: '7',
    owner_name: 'Me',
    status: 'online',
    updated_at: '',
  }
  try {
    await act(async () =>
      root.render(
        <TemplateEnvironmentSelection
          locale="zh-CN"
          disabled={false}
          selected={[]}
          onChange={onChange}
          environments={[
            device,
            {
              ...device,
              id: '2',
              device_id: 2,
              name: 'Offline Mac',
              status: 'offline',
            },
            {
              ...device,
              id: '3',
              device_id: 3,
              name: 'No permission',
              can_use: false,
            },
            {
              ...device,
              id: '4',
              device_id: 4,
              name: 'Starting',
              status: 'provisioning',
            },
          ]}
        />
      )
    )
    expect(
      container
        .querySelector('[data-testid="template-environment-selection-toggle"]')
        ?.getAttribute('aria-expanded')
    ).toBe('false')
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(1)
    expect(container.textContent).not.toMatch(/Offline Mac|No permission|Starting|默认执行环境/)
    expect(container.textContent).toContain('运行环境（可选）')
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-testid="template-environment-selection-toggle"]')!
        .click()
    )
    const checkbox = container.querySelector<HTMLElement>('[role="checkbox"]')!
    expect(checkbox.closest('label')!.textContent).toContain('Online Mac')
    await act(async () => checkbox.click())
    expect(onChange).toHaveBeenCalledWith([1])
    await act(async () =>
      root.render(
        <TemplateEnvironmentSelection
          locale="zh-CN"
          disabled={false}
          selected={[]}
          onChange={onChange}
          environments={[]}
        />
      )
    )
    expect(container.textContent).toContain('可先创建项目')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
