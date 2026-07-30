import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalDeviceApp } from '@/types/api'
import { INSERT_PLUGIN_REFERENCE_EVENT, recordPluginUsage } from '@/features/plugins/pluginTrial'
import { PluginPickerMenu } from './PluginPickerMenu'
import { RECENT_PLUGIN_APPS_KEY } from './composerPluginSort'

const githubApp: LocalDeviceApp = {
  id: 'github',
  name: 'GitHub',
  description:
    '检查仓库、处理拉取请求和 Issue、调试 CI，并通过 GitHub 连接器与 CLI 工作流发布代码变更。',
  isAccessible: true,
  isEnabled: true,
}

const superpowersApp: LocalDeviceApp = {
  id: 'plugin:superpowers',
  name: 'superpowers',
  description: 'A complete software development workflow for coding agents',
  isAccessible: true,
  isEnabled: true,
  source: 'installed-plugin',
  skillPath: 'plugin://superpowers@openai-official',
}

const echoIdApp: LocalDeviceApp = {
  id: 'echoid',
  name: 'EchoID',
  description: 'Identify speaker and save corrected transcripts locally.',
  isAccessible: true,
  isEnabled: true,
}

describe('PluginPickerMenu', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('lists installed plugins without descriptions and inserts a skill-only plugin', async () => {
    const onListLocalApps = vi.fn().mockResolvedValue([githubApp, superpowersApp])
    const inserted: string[] = []
    const onInsert = (event: Event) => {
      const detail = (event as CustomEvent<{ reference?: string }>).detail
      if (detail?.reference) inserted.push(detail.reference)
    }
    window.addEventListener(INSERT_PLUGIN_REFERENCE_EVENT, onInsert)

    render(<PluginPickerMenu onListLocalApps={onListLocalApps} />)

    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    const picker = await screen.findByTestId('composer-plugin-picker')

    expect(picker).toHaveTextContent('可用插件')
    expect(picker).toHaveTextContent('GitHub')
    expect(picker).toHaveTextContent('superpowers')
    expect(picker).not.toHaveTextContent('检查仓库')
    expect(picker).not.toHaveTextContent('A complete software development workflow')
    expect(picker).not.toHaveTextContent('浏览和搜索全部插件')

    await userEvent.click(screen.getByTestId('composer-plugin-picker-item-plugin:superpowers'))

    await waitFor(() => {
      expect(inserted).toEqual(['[$superpowers](plugin://superpowers@openai-official)'])
    })

    window.removeEventListener(INSERT_PLUGIN_REFERENCE_EVENT, onInsert)
  })

  test('orders available plugins by usage count then recent selection', async () => {
    recordPluginUsage('EchoID')
    recordPluginUsage('EchoID')
    recordPluginUsage('GitHub')
    window.localStorage.setItem(RECENT_PLUGIN_APPS_KEY, JSON.stringify(['github']))

    const onListLocalApps = vi.fn().mockResolvedValue([superpowersApp, githubApp, echoIdApp])

    render(<PluginPickerMenu onListLocalApps={onListLocalApps} />)
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    const picker = await screen.findByTestId('composer-plugin-picker')

    const items = within(picker)
      .getAllByTestId(/^composer-plugin-picker-item-/)
      .map(node => node.getAttribute('data-testid'))
    expect(items).toEqual([
      'composer-plugin-picker-item-echoid',
      'composer-plugin-picker-item-github',
      'composer-plugin-picker-item-plugin:superpowers',
    ])
  })
})
