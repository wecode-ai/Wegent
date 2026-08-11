import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalDeviceApp } from '@/types/api'
import {
  INSERT_PLUGIN_REFERENCE_EVENT,
  notifyLocalPluginSkillsChanged,
  recordPluginUsage,
  SHOW_PLUGIN_TRIAL_GUIDE_EVENT,
} from '@/features/plugins/pluginTrial'
import { PluginPickerMenu } from './PluginPickerMenu'
import {
  COMPOSER_APPS_REQUEST_SYNC_EVENT,
  clearComposerAppsSnapshot,
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
    const onInsert = (event: Event) => {
      const detail = (event as CustomEvent<{ reference?: string }>).detail
      if (detail?.reference) inserted.push(detail.reference)
    }
    window.addEventListener(INSERT_PLUGIN_REFERENCE_EVENT, onInsert)
    const onShowGuide = (event: Event) => {
      const detail = (event as CustomEvent<{ pluginName?: string }>).detail
      if (detail?.pluginName) shownGuides.push(detail.pluginName)
    }
    window.addEventListener(SHOW_PLUGIN_TRIAL_GUIDE_EVENT, onShowGuide)

    render(<PluginPickerMenu onListLocalApps={onListLocalApps} />)

    const trigger = screen.getByTestId('composer-plugin-picker-button')
    await waitFor(() =>
      expect(screen.getAllByTestId(/composer-plugin-preview-icon-/)).toHaveLength(3)
    )
    expect(trigger).toHaveClass('h-8', 'rounded-xl', 'bg-muted')
    expect(screen.getByTestId('composer-plugin-preview-icons')).toHaveClass('-space-x-1')
    expect(screen.getByTestId('composer-plugin-preview-icon-github')).toHaveClass(
      'h-6',
      'w-6',
      'rounded-full',
      'border-border/30'
    )
    expect(trigger).toHaveTextContent('+2')

    await userEvent.click(trigger)
    const picker = await screen.findByTestId('composer-plugin-picker')

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

    window.removeEventListener(INSERT_PLUGIN_REFERENCE_EVENT, onInsert)
    window.removeEventListener(SHOW_PLUGIN_TRIAL_GUIDE_EVENT, onShowGuide)
  })

  test('renders a single icon trigger when iconOnly is set', async () => {
    const onListLocalApps = vi.fn().mockResolvedValue([githubApp, superpowersApp, echoIdApp])

    render(<PluginPickerMenu iconOnly onListLocalApps={onListLocalApps} />)

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

  test('paints preview icons from the composer apps snapshot before fetch resolves', async () => {
    publishComposerApps([githubApp, superpowersApp, echoIdApp])
    let resolveApps!: (apps: LocalDeviceApp[]) => void
    const onListLocalApps = vi.fn(
      () =>
        new Promise<LocalDeviceApp[]>(resolve => {
          resolveApps = resolve
        })
    )

    render(<PluginPickerMenu onListLocalApps={onListLocalApps} />)

    expect(screen.getAllByTestId(/composer-plugin-preview-icon-/)).toHaveLength(3)
    expect(screen.getByTestId('composer-plugin-picker-button')).toHaveTextContent('插件')

    resolveApps([githubApp, superpowersApp])
    await waitFor(() =>
      expect(screen.getAllByTestId(/composer-plugin-preview-icon-/)).toHaveLength(2)
    )
  })

  test('keeps visible plugins while a skills-changed refresh is in flight', async () => {
    publishComposerApps([superpowersApp])
    const onListLocalApps = vi.fn().mockResolvedValue([superpowersApp])

    render(<PluginPickerMenu onListLocalApps={onListLocalApps} />)
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
      resetComposerAppsMemory()
      clearComposerAppsSnapshot()
      resolveRefresh([])
    })
    await waitFor(() =>
      expect(
        screen.queryByTestId('composer-plugin-picker-item-plugin:superpowers')
      ).not.toBeInTheDocument()
    )
  })

  test('keeps snapshot plugins visible when a refresh returns empty', async () => {
    publishComposerApps([superpowersApp])
    let resolveApps!: (apps: LocalDeviceApp[]) => void
    const onListLocalApps = vi.fn(
      () =>
        new Promise<LocalDeviceApp[]>(resolve => {
          resolveApps = resolve
        })
    )

    render(<PluginPickerMenu onListLocalApps={onListLocalApps} />)
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    expect(
      await screen.findByTestId('composer-plugin-picker-item-plugin:superpowers')
    ).toBeInTheDocument()

    await act(async () => resolveApps([]))
    expect(screen.getByTestId('composer-plugin-picker-item-plugin:superpowers')).toBeInTheDocument()
  })

  test('clears visible plugins when the shared composer app store is explicitly emptied', async () => {
    publishComposerApps([superpowersApp])
    const onListLocalApps = vi.fn().mockResolvedValue([superpowersApp])

    render(<PluginPickerMenu onListLocalApps={onListLocalApps} />)
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

  test('shows plugins published by slash autocomplete even when fetch returns empty', async () => {
    const onListLocalApps = vi.fn().mockResolvedValue([])
    render(<PluginPickerMenu onListLocalApps={onListLocalApps} />)

    await waitFor(() => expect(onListLocalApps).toHaveBeenCalled())
    expect(screen.queryByTestId(/composer-plugin-preview-icon-/)).not.toBeInTheDocument()

    act(() => {
      publishComposerApps([githubApp, superpowersApp])
    })

    await waitFor(() =>
      expect(screen.getAllByTestId(/composer-plugin-preview-icon-/)).toHaveLength(2)
    )
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    expect(await screen.findByTestId('composer-plugin-picker-item-github')).toBeInTheDocument()
    expect(screen.getByTestId('composer-plugin-picker-item-plugin:superpowers')).toBeInTheDocument()
  })

  test('pulls slash React apps via sync event when the shared store was empty', async () => {
    const onListLocalApps = vi.fn().mockResolvedValue([])
    window.addEventListener(COMPOSER_APPS_REQUEST_SYNC_EVENT, () => {
      publishComposerApps([githubApp, echoIdApp])
    })

    render(<PluginPickerMenu onListLocalApps={onListLocalApps} />)
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))

    expect(await screen.findByTestId('composer-plugin-picker-item-github')).toBeInTheDocument()
    expect(screen.getByTestId('composer-plugin-picker-item-echoid')).toBeInTheDocument()
  })
})
