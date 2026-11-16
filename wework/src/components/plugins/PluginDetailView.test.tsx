import '@/i18n'
import type { InstalledPlugin } from '@/types/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { PluginDetailView } from './PluginDetailView'
import type { InstalledPluginItem } from './PluginManagementRows'
import { pluginDetailPrimaryActionPending } from './pluginDetailReadyToTry'

function createDetailPlugin(): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'wegent.ai/v1',
    kind: 'InstalledPlugin',
    metadata: {},
    spec: {
      source: {
        type: 'local',
        providerKey: 'personal',
        pluginKey: 'dev-tools',
      },
      origin: 'created',
      displayName: 'Dev Tools',
      description: 'Developer tools',
      installState: 'installed',
      enabled: true,
      version: '0.1.0',
      manifest: {},
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcps: [],
        lsps: [],
        monitors: [],
        bins: [],
      },
      interface: null,
    },
    status: { state: 'installed' },
  }

  return {
    id: 'local-1',
    name: 'Dev Tools',
    description: 'Developer tools',
    enabled: true,
    version: '0.1.0',
    origin: 'created',
    sourceLabel: '个人创建',
    distribution: 'personal',
    updateAvailable: false,
    componentCounts: {},
    raw,
  }
}

describe('PluginDetailView owner actions', () => {
  test('keeps the header while detail content has a stable loading placeholder', () => {
    const plugin = createDetailPlugin()
    const props = {
      plugin,
      onBack: vi.fn(),
      onToggle: vi.fn(),
      onComponentToggle: vi.fn(),
      onUninstall: vi.fn(),
      onPromptSelect: vi.fn(),
    }
    const result = render(<PluginDetailView {...props} detailLoading />)
    expect(screen.getByTestId('plugin-detail-loading')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Dev Tools')).toBeInTheDocument()
    expect(screen.queryByText('Developer tools')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugin-detail-info')).not.toBeInTheDocument()
    result.rerender(<PluginDetailView {...props} />)
    expect(screen.queryByTestId('plugin-detail-loading')).not.toBeInTheDocument()
    expect(screen.getByText('Developer tools')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-detail-info')).toBeInTheDocument()
  })
  test('keeps a healthy installed plugin usable while reconciliation is running', () => {
    const onToggle = vi.fn()
    render(
      <PluginDetailView
        plugin={createDetailPlugin()}
        onBack={vi.fn()}
        onToggle={onToggle}
        onComponentToggle={vi.fn()}
        onUninstall={vi.fn()}
        primaryActionDisabled={pluginDetailPrimaryActionPending({
          operationPending: false,
          reconciling: true,
          readyToTry: true,
          updateAvailable: false,
        })}
      />
    )
    fireEvent.click(screen.getByTestId('plugin-detail-toggle-local-1'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  test('keeps the overflow menu left of the primary action for uninstalled plugins', () => {
    const plugin = createDetailPlugin()
    plugin.raw.spec.installState = 'available'
    plugin.enabled = false
    const onDeleteAction = vi.fn()

    render(
      <PluginDetailView
        plugin={plugin}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onComponentToggle={vi.fn()}
        onUninstall={vi.fn()}
        showUninstall={false}
        primaryActionLabel="安装插件"
        primaryActionIcon="install"
        onDeleteAction={onDeleteAction}
      />
    )

    const actions = screen.getByTestId('plugin-detail-actions-bar')
    const menu = screen.getByTestId('plugin-detail-actions-local-1')
    const primary = screen.getByTestId('plugin-detail-toggle-local-1')
    expect(Array.from(actions.children).indexOf(menu.parentElement!)).toBeLessThan(
      Array.from(actions.children).indexOf(primary)
    )

    fireEvent.click(menu)
    fireEvent.click(screen.getByTestId('plugin-detail-delete-local-1'))
    expect(onDeleteAction).toHaveBeenCalledTimes(1)
  })
})
