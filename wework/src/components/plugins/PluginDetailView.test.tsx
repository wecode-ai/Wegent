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
  test('deduplicates identical category and publisher metadata', () => {
    const plugin = createDetailPlugin()
    plugin.raw.spec.interface = {
      category: '个人创建',
    }

    render(
      <PluginDetailView
        plugin={plugin}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onComponentToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByText('个人创建 · v0.1.0')).toBeInTheDocument()
    expect(screen.queryByText('个人创建 · 个人创建 · v0.1.0')).not.toBeInTheDocument()
  })

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

  test('keeps automatic update controls visible for a materialized outdated release', () => {
    const plugin = createDetailPlugin()
    plugin.raw.spec.source = {
      type: 'marketplace',
      providerKey: 'wegent-market',
      pluginKey: 'dev-tools',
    }
    plugin.raw.spec.pluginId = 101
    plugin.raw.spec.installState = 'update_available'
    plugin.raw.spec.updatePolicy = 'auto'
    plugin.raw.status.devices = [
      {
        deviceId: 'current-device',
        desiredReleaseId: 102,
        actualReleaseId: 101,
        state: 'failed',
        attemptCount: 3,
        updatedAt: '2026-08-13T10:00:00Z',
      },
    ]

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

    expect(screen.getByTestId('plugin-auto-update-toggle-local-1')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-auto-update-paused-local-1')).toHaveTextContent('3')
  })

  test('keeps manage access in availability and orders share before menu and chat', () => {
    const onManageAccess = vi.fn()
    const onShareAction = vi.fn()

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
        shareActionLabel="分享"
        onShareAction={onShareAction}
        primaryActionLabel="立即对话"
      />
    )

    expect(screen.queryByTestId('plugin-detail-secondary-local-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugin-detail-manage-access')).toHaveTextContent('管理权限')
    const actions = screen.getByTestId('plugin-detail-actions-bar')
    const share = screen.getByTestId('plugin-detail-share-local-1')
    const menu = screen.getByTestId('plugin-detail-actions-local-1')
    const primary = screen.getByTestId('plugin-detail-toggle-local-1')
    expect(Array.from(actions.children).indexOf(share)).toBeLessThan(
      Array.from(actions.children).indexOf(menu.parentElement!)
    )
    expect(Array.from(actions.children).indexOf(menu.parentElement!)).toBeLessThan(
      Array.from(actions.children).indexOf(primary)
    )
    fireEvent.click(share)
    expect(onShareAction).toHaveBeenCalledTimes(1)
  })

  test('links an enterprise release back to its personal source for the owner', () => {
    const onOpenOriginPersonalPlugin = vi.fn()
    render(
      <PluginDetailView
        plugin={createDetailPlugin()}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onComponentToggle={vi.fn()}
        onUninstall={vi.fn()}
        originPersonalActionLabel="查看个人创建版本"
        onOpenOriginPersonalPlugin={onOpenOriginPersonalPlugin}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-detail-open-origin-personal'))
    expect(onOpenOriginPersonalPlugin).toHaveBeenCalledTimes(1)
  })

  test('closes the overflow menu when clicking outside', () => {
    render(
      <PluginDetailView
        plugin={createDetailPlugin()}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onComponentToggle={vi.fn()}
        onUninstall={vi.fn()}
        editActionLabel="继续编辑"
        onEditAction={vi.fn()}
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
