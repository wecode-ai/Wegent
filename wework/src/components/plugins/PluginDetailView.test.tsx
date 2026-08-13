import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { InstalledPlugin } from '@/types/api'
import { PluginDetailView } from './PluginDetailView'
import type { InstalledPluginItem } from './PluginManagementRows'

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
  test('allows automatic updates to be changed explicitly', () => {
    const plugin = createDetailPlugin()
    plugin.raw.spec.source = {
      type: 'marketplace',
      providerKey: 'wegent-market',
      pluginKey: 'dev-tools',
    }
    plugin.raw.spec.pluginId = 101
    plugin.raw.spec.updatePolicy = 'manual'
    const onAutoUpdateChange = vi.fn()

    render(
      <PluginDetailView
        plugin={plugin}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onComponentToggle={vi.fn()}
        onUninstall={vi.fn()}
        autoUpdateEnabled={false}
        onAutoUpdateChange={onAutoUpdateChange}
      />
    )

    const toggle = screen.getByTestId('plugin-auto-update-toggle-local-1')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(onAutoUpdateChange).toHaveBeenCalledWith(true)
  })

  test('shows when automatic updates pause after repeated failures', () => {
    const plugin = createDetailPlugin()
    plugin.raw.spec.source = {
      type: 'marketplace',
      providerKey: 'wegent-market',
      pluginKey: 'dev-tools',
    }
    plugin.raw.spec.pluginId = 101
    plugin.raw.spec.updatePolicy = 'auto'

    render(
      <PluginDetailView
        plugin={plugin}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onComponentToggle={vi.fn()}
        onUninstall={vi.fn()}
        autoUpdateEnabled
        autoUpdatePaused
        autoUpdateFailureCount={3}
        onAutoUpdateChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('plugin-auto-update-paused-local-1')).toHaveTextContent('3')
  })

  test('keeps manage access in the availability section and publish new version in the menu', () => {
    const onManageAccess = vi.fn()
    const onMenuPublish = vi.fn()

    render(
      <PluginDetailView
        plugin={createDetailPlugin()}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onComponentToggle={vi.fn()}
        onUninstall={vi.fn()}
        accessRole="owner"
        pluginVisibility="personal"
        shareGrantUserCount={3}
        shareGrantNamespaceCount={0}
        onManageAccess={onManageAccess}
        menuPublishLabel="发布新版本"
        onMenuPublish={onMenuPublish}
      />
    )

    expect(screen.queryByTestId('plugin-detail-secondary-local-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugin-detail-manage-access')).toHaveTextContent('管理权限')
    fireEvent.click(screen.getByTestId('plugin-detail-actions-local-1'))
    expect(screen.getByTestId('plugin-detail-menu-publish-local-1')).toHaveTextContent('发布新版本')
  })

  test('closes the overflow menu when clicking outside', () => {
    render(
      <PluginDetailView
        plugin={createDetailPlugin()}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onComponentToggle={vi.fn()}
        onUninstall={vi.fn()}
        menuPublishLabel="发布新版本"
        onMenuPublish={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-detail-actions-local-1'))
    expect(screen.getByTestId('plugin-detail-actions-menu-local-1')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('plugin-detail-actions-menu-local-1')).not.toBeInTheDocument()
  })

  test('puts copy-to-personal into the overflow menu instead of the header', () => {
    const onTertiaryAction = vi.fn()
    render(
      <PluginDetailView
        plugin={createDetailPlugin()}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onComponentToggle={vi.fn()}
        onUninstall={vi.fn()}
        shareRecipient
        tertiaryActionLabel="复制到我的插件"
        onTertiaryAction={onTertiaryAction}
      />
    )

    expect(screen.queryByTestId('plugin-detail-tertiary-local-1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('plugin-detail-actions-local-1'))
    fireEvent.click(screen.getByTestId('plugin-detail-menu-copy-local-1'))
    expect(onTertiaryAction).toHaveBeenCalledTimes(1)
  })
})
