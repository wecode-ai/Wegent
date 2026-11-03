import type { LocalDeviceApp } from '@/types/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PluginTrialSelectionContext } from '@wegent/collaboration/composer/PluginTrialSelectionContext'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { PluginPickerMenu } from './PluginPickerMenu'
import { publishComposerApps, resetComposerAppsMemory } from './composerAppsSnapshot'

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
  trialTemplates: [
    {
      name: 'Plan an implementation',
      path: 'plan-implementation',
      description: 'Plan an implementation before changing code',
    },
  ],
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
    resetComposerAppsMemory()
  })

  test('searches and selects an installed GitHub plugin pending authorization, not its inaccessible app', async () => {
    const pending = {
      ...githubApp,
      id: 'plugin:github',
      pluginKey: 'github',
      source: 'installed-plugin',
      isAccessible: false,
      skillPath: 'plugin://github@openai-curated-remote',
    }
    const insert = vi.fn()
    render(
      <PluginPickerMenu
        onInsertReference={insert}
        onListLocalApps={async () => [
          pending,
          { ...githubApp, id: 'uninstalled-app', isAccessible: false },
        ]}
      />
    )
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    await userEvent.type(screen.getByTestId('composer-plugin-picker-search'), 'github')
    const option = await screen.findByTestId('composer-plugin-picker-item-plugin:github')
    expect(option).toHaveTextContent('待授权')
    expect(option).toBeEnabled()
    expect(
      screen.queryByTestId('composer-plugin-picker-item-uninstalled-app')
    ).not.toBeInTheDocument()
    await userEvent.click(option)
    expect(insert).toHaveBeenCalledWith('[$GitHub](plugin://github@openai-curated-remote)')
    expect(pending.isAccessible).toBe(false)
  })

  test('lists installed plugins with capability descriptions and inserts a skill-only plugin', async () => {
    const onListLocalApps = vi
      .fn()
      .mockResolvedValue([
        githubApp,
        superpowersApp,
        { ...githubApp, id: 'gitlab', name: 'GitLab' },
        { ...githubApp, id: 'linear', name: 'Linear' },
        { ...githubApp, id: 'notion', name: 'Notion' },
      ])
    const inserted: string[] = []
    const shownGuides: string[] = []
    render(
      <PluginTrialSelectionContext.Provider value={title => shownGuides.push(title)}>
        <PluginPickerMenu
          onInsertReference={reference => inserted.push(reference)}
          onListLocalApps={onListLocalApps}
        />
      </PluginTrialSelectionContext.Provider>
    )

    const trigger = screen.getByTestId('composer-plugin-picker-button')
    expect(trigger).toHaveClass('h-8', 'rounded-xl', 'bg-muted')
    expect(onListLocalApps).not.toHaveBeenCalled()

    await userEvent.click(trigger)
    const picker = await screen.findByTestId('composer-plugin-picker')

    expect(picker).toHaveClass('bg-popover', 'text-text-primary')
    await waitFor(() =>
      expect(screen.getAllByTestId(/composer-plugin-preview-icon-/)).toHaveLength(3)
    )
    expect(screen.getByTestId('composer-plugin-preview-icons')).toHaveClass('-space-x-1')
    expect(screen.getByTestId('composer-plugin-preview-icon-github')).toHaveClass(
      'plugin-icon-slot',
      'h-6',
      'w-6',
      'rounded-full'
    )
    expect(trigger).toHaveTextContent('+2')
    expect(picker).toHaveTextContent('可用插件')
    expect(picker).toHaveTextContent('GitHub')
    expect(picker).toHaveTextContent('superpowers')
    expect(picker).toHaveTextContent('检查仓库')
    expect(picker).toHaveTextContent('A complete software development workflow')
    expect(picker).not.toHaveTextContent('浏览和搜索全部插件')
    expect(screen.getByTestId('composer-plugin-picker-item-github')).toHaveClass('grid', 'min-h-10')

    await userEvent.click(screen.getByTestId('composer-plugin-picker-item-plugin:superpowers'))

    await waitFor(() => {
      expect(inserted).toEqual(['[$superpowers](plugin://superpowers@openai-official)'])
    })
    expect(shownGuides).toEqual(['superpowers'])
  })

  test('renders all plugins in the height-limited list and searches without truncation', async () => {
    const apps: LocalDeviceApp[] = Array.from({ length: 20 }, (_, index) => ({
      ...superpowersApp,
      id: `plugin:example-${index + 1}`,
      name: `Example ${String(index + 1).padStart(2, '0')}`,
      skillPath: `plugin://example-${index + 1}@test`,
    }))
    const onInsertReference = vi.fn()
    render(
      <PluginPickerMenu
        onInsertReference={onInsertReference}
        onListLocalApps={vi.fn().mockResolvedValue(apps)}
      />
    )

    const trigger = screen.getByTestId('composer-plugin-picker-button')
    await userEvent.click(trigger)
    const picker = await screen.findByTestId('composer-plugin-picker')
    await waitFor(() =>
      expect(within(picker).getAllByTestId(/^composer-plugin-picker-item-/)).toHaveLength(20)
    )
    expect(screen.getAllByTestId(/composer-plugin-preview-icon-/)).toHaveLength(3)
    expect(trigger).toHaveTextContent('+17')
    const lastItem = within(picker).getByTestId('composer-plugin-picker-item-plugin:example-20')
    expect(lastItem.parentElement).toHaveClass('min-h-0', 'max-h-[280px]', 'overflow-y-auto')

    const search = within(picker).getByTestId('composer-plugin-picker-search')
    await userEvent.type(search, 'Example')
    expect(within(picker).getAllByTestId(/^composer-plugin-picker-item-/)).toHaveLength(20)
    await userEvent.type(search, ' 20')
    expect(within(picker).getAllByTestId(/^composer-plugin-picker-item-/)).toHaveLength(1)
    await userEvent.clear(search)
    expect(within(picker).getAllByTestId(/^composer-plugin-picker-item-/)).toHaveLength(20)

    await userEvent.click(
      within(picker).getByTestId('composer-plugin-picker-item-plugin:example-20')
    )
    expect(onInsertReference).toHaveBeenCalledWith('[$Example 20](plugin://example-20@test)')
    expect(screen.queryByTestId('composer-plugin-picker')).not.toBeInTheDocument()
  })

  test('shows a failed refresh and retries without hiding previously loaded plugins', async () => {
    publishComposerApps([githubApp])
    const onListLocalApps = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([echoIdApp])
    render(<PluginPickerMenu onInsertReference={vi.fn()} onListLocalApps={onListLocalApps} />)
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    expect(await screen.findByTestId('composer-plugin-picker-error')).toHaveTextContent(
      '加载插件失败'
    )
    expect(screen.getByTestId('composer-plugin-picker-item-github')).toBeInTheDocument()
    expect(onListLocalApps).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByTestId('composer-plugin-picker-retry'))
    expect(await screen.findByTestId('composer-plugin-picker-item-echoid')).toBeInTheDocument()
    expect(screen.queryByTestId('composer-plugin-picker-error')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-plugin-picker-item-github')).not.toBeInTheDocument()
  })

  test('does not describe an initial load failure as an empty installed catalog', async () => {
    render(
      <PluginPickerMenu
        onInsertReference={vi.fn()}
        onListLocalApps={async () => {
          throw new Error('offline')
        }}
      />
    )
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    expect(await screen.findByTestId('composer-plugin-picker-error')).toBeInTheDocument()
    expect(screen.queryByText('当前账号没有已安装且启用的匹配插件。')).not.toBeInTheDocument()
  })
})
