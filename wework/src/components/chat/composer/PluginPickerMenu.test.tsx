import { PluginTrialSelectionContext } from '@wegent/collaboration/composer/PluginTrialSelectionContext'
import { createComposerCatalogStore } from '@wegent/collaboration/composer/createComposerCatalogStore'
import { ComposerCatalogContext } from './ComposerCatalogContext'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalDeviceApp } from '@/types/api'
import { notifyLocalPluginSkillsChanged, recordPluginUsage } from '@/features/plugins/pluginTrial'
import { PluginPickerMenu } from './PluginPickerMenu'
import {
  publishComposerApps,
  replaceComposerApps,
  resetComposerAppsMemory,
} from './composerAppsSnapshot'
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

  test('uses its task catalog instead of the global snapshot and inherited loader', async () => {
    publishComposerApps([githubApp])
    const inherited = vi.fn().mockResolvedValue([githubApp])
    const scoped = vi.fn().mockResolvedValue([superpowersApp])
    const store = createComposerCatalogStore<LocalDeviceApp>()
    render(
      <ComposerCatalogContext.Provider
        value={{ appsStore: store, catalogEvents: {}, listApps: scoped, prefetchLocalAuth: false }}
      >
        <PluginPickerMenu onInsertReference={vi.fn()} onListLocalApps={inherited} />
      </ComposerCatalogContext.Provider>
    )
    expect(screen.queryByTestId('composer-plugin-preview-icon-github')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    expect(
      await screen.findByTestId('composer-plugin-picker-item-plugin:superpowers')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('composer-plugin-picker-item-github')).not.toBeInTheDocument()
    expect(scoped).toHaveBeenCalledTimes(1)
    expect(inherited).not.toHaveBeenCalled()
    expect(store.get()).toEqual([superpowersApp])
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

  test('renders a single icon trigger when iconOnly is set', async () => {
    const onListLocalApps = vi.fn().mockResolvedValue([githubApp, superpowersApp, echoIdApp])

    render(
      <PluginPickerMenu onInsertReference={vi.fn()} iconOnly onListLocalApps={onListLocalApps} />
    )

    const trigger = screen.getByTestId('composer-plugin-picker-button')
    expect(trigger).toHaveClass('h-7', 'w-7', 'rounded-lg')
    expect(trigger).not.toHaveTextContent('插件')
    expect(screen.queryByTestId(/composer-plugin-preview-icon-/)).not.toBeInTheDocument()

    await userEvent.click(trigger)
    expect(await screen.findByTestId('composer-plugin-picker-item-github')).toBeInTheDocument()
  })

  test('orders available plugins by usage count then recent selection', async () => {
    recordPluginUsage('EchoID')
    recordPluginUsage('EchoID')
    recordPluginUsage('GitHub')
    window.localStorage.setItem(RECENT_PLUGIN_APPS_KEY, JSON.stringify(['github']))

    const onListLocalApps = vi.fn().mockResolvedValue([superpowersApp, githubApp, echoIdApp])

    render(<PluginPickerMenu onInsertReference={vi.fn()} onListLocalApps={onListLocalApps} />)
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

  test('paints preview icons from the composer apps snapshot before fetch resolves', async () => {
    publishComposerApps([githubApp, superpowersApp, echoIdApp])
    let resolveApps!: (apps: LocalDeviceApp[]) => void
    const onListLocalApps = vi.fn(
      () =>
        new Promise<LocalDeviceApp[]>(resolve => {
          resolveApps = resolve
        })
    )

    render(<PluginPickerMenu onInsertReference={vi.fn()} onListLocalApps={onListLocalApps} />)

    expect(screen.getAllByTestId(/composer-plugin-preview-icon-/)).toHaveLength(3)
    expect(screen.getByTestId('composer-plugin-picker-button')).toHaveTextContent('插件')
    expect(onListLocalApps).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    await waitFor(() => expect(onListLocalApps).toHaveBeenCalledTimes(1))
    resolveApps([githubApp, superpowersApp])
    await waitFor(() =>
      expect(screen.getAllByTestId(/composer-plugin-preview-icon-/)).toHaveLength(2)
    )
  })

  test('keeps visible plugins while a skills-changed refresh is in flight', async () => {
    publishComposerApps([superpowersApp])
    const onListLocalApps = vi.fn().mockResolvedValue([superpowersApp])

    render(<PluginPickerMenu onInsertReference={vi.fn()} onListLocalApps={onListLocalApps} />)
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    expect(
      await screen.findByTestId('composer-plugin-picker-item-plugin:superpowers')
    ).toBeInTheDocument()

    let resolveRefresh!: (apps: LocalDeviceApp[]) => void
    const refresh = new Promise<LocalDeviceApp[]>(resolve => {
      resolveRefresh = resolve
    })
    onListLocalApps.mockImplementationOnce(() => refresh)
    act(() => notifyLocalPluginSkillsChanged())

    expect(screen.getByTestId('composer-plugin-picker-item-plugin:superpowers')).toBeInTheDocument()

    await act(async () => {
      resolveRefresh([])
    })
    await waitFor(() =>
      expect(
        screen.queryByTestId('composer-plugin-picker-item-plugin:superpowers')
      ).not.toBeInTheDocument()
    )
  })

  test('clears snapshot plugins when a completed refresh returns empty', async () => {
    publishComposerApps([superpowersApp])
    let resolveApps!: (apps: LocalDeviceApp[]) => void
    const onListLocalApps = vi.fn(
      () =>
        new Promise<LocalDeviceApp[]>(resolve => {
          resolveApps = resolve
        })
    )

    render(<PluginPickerMenu onInsertReference={vi.fn()} onListLocalApps={onListLocalApps} />)
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    expect(
      await screen.findByTestId('composer-plugin-picker-item-plugin:superpowers')
    ).toBeInTheDocument()

    await act(async () => resolveApps([]))
    expect(
      screen.queryByTestId('composer-plugin-picker-item-plugin:superpowers')
    ).not.toBeInTheDocument()
    expect(onListLocalApps).toHaveBeenCalledTimes(1)
  })

  test('clears visible plugins when the shared composer app store is explicitly emptied', async () => {
    publishComposerApps([superpowersApp])
    const onListLocalApps = vi.fn().mockResolvedValue([superpowersApp])

    render(<PluginPickerMenu onInsertReference={vi.fn()} onListLocalApps={onListLocalApps} />)
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    expect(
      await screen.findByTestId('composer-plugin-picker-item-plugin:superpowers')
    ).toBeInTheDocument()

    act(() => replaceComposerApps([]))

    await waitFor(() =>
      expect(
        screen.queryByTestId('composer-plugin-picker-item-plugin:superpowers')
      ).not.toBeInTheDocument()
    )
  })

  test('updates slash snapshots with the authoritative empty response', async () => {
    const onListLocalApps = vi.fn().mockResolvedValue([])
    render(<PluginPickerMenu onInsertReference={vi.fn()} onListLocalApps={onListLocalApps} />)

    expect(onListLocalApps).not.toHaveBeenCalled()
    expect(screen.queryByTestId(/composer-plugin-preview-icon-/)).not.toBeInTheDocument()

    act(() => {
      publishComposerApps([githubApp, superpowersApp])
    })

    await waitFor(() =>
      expect(screen.getAllByTestId(/composer-plugin-preview-icon-/)).toHaveLength(2)
    )
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    await waitFor(() => expect(onListLocalApps).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('composer-plugin-picker-item-github')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('composer-plugin-picker-item-plugin:superpowers')
    ).not.toBeInTheDocument()
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

  test('keeps portal clicks inside the menu and restores focus on Escape', async () => {
    const onListLocalApps = vi.fn().mockResolvedValue([githubApp])
    const { container } = render(
      <div style={{ overflow: 'hidden' }}>
        <PluginPickerMenu onInsertReference={vi.fn()} onListLocalApps={onListLocalApps} />
      </div>
    )
    const trigger = screen.getByTestId('composer-plugin-picker-button')
    await userEvent.click(trigger)
    await screen.findByTestId('composer-plugin-picker-item-github')
    expect(container).not.toContainElement(screen.getByTestId('composer-plugin-picker'))
    await userEvent.click(screen.getByTestId('composer-plugin-picker-search'))
    await userEvent.type(screen.getByTestId('composer-plugin-picker-search'), 'Git')
    expect(screen.getByTestId('composer-plugin-picker-item-github')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('composer-plugin-picker')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  test('selects a plugin even with malformed stored recent IDs', async () => {
    window.localStorage.setItem(RECENT_PLUGIN_APPS_KEY, '{broken')
    render(
      <PluginPickerMenu onInsertReference={vi.fn()} onListLocalApps={async () => [githubApp]} />
    )
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    await userEvent.click(await screen.findByTestId('composer-plugin-picker-item-github'))
    expect(JSON.parse(window.localStorage.getItem(RECENT_PLUGIN_APPS_KEY)!)).toEqual(['github'])
    expect(screen.queryByTestId('composer-plugin-picker')).not.toBeInTheDocument()
  })
  test('renders an explicitly supplied catalog when no refresh callback is available', async () => {
    publishComposerApps([githubApp])
    render(<PluginPickerMenu onInsertReference={vi.fn()} />)
    expect(screen.getByTestId('composer-plugin-preview-icon-github')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    expect(screen.getByTestId('composer-plugin-picker-item-github')).toBeInTheDocument()
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
