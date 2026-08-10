import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { InstalledPluginRow, type InstalledPluginItem } from './PluginManagementRows'
import { buildInstalledPluginSubtitle } from './pluginManagementSubtitle'

function createPlugin(options?: { logo?: string; pluginKey?: string }): InstalledPluginItem {
  const pluginKey = options?.pluginKey ?? 'github'
  const raw: InstalledPlugin = {
    apiVersion: 'wegent.ai/v1',
    kind: 'InstalledPlugin',
    metadata: {},
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent',
        pluginKey,
      },
      displayName: 'GitHub',
      description: 'GitHub plugin',
      installState: 'installed',
      enabled: true,
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
      interface: options?.logo ? { logo: options.logo } : null,
    },
    status: { state: 'installed' },
  }

  return {
    id: 59,
    name: 'GitHub',
    description: 'GitHub plugin',
    enabled: true,
    version: '0.1.6+wegent.2',
    origin: 'market',
    sourceLabel: 'Wegent',
    distribution: 'workspace',
    updateAvailable: false,
    componentCounts: {},
    raw,
  }
}

describe('InstalledPluginRow', () => {
  test('renders the plugin logo from its installed release metadata', () => {
    render(
      <InstalledPluginRow
        plugin={createPlugin({ logo: 'data:image/png;base64,cG5n' })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByTestId('installed-plugin-logo-59')).toHaveAttribute(
      'src',
      'data:image/png;base64,cG5n'
    )
    expect(screen.getByTestId('installed-plugin-logo-frame-59')).toHaveClass('plugin-logo-provided')
    expect(screen.getByTestId('installed-plugin-origin-59')).toHaveTextContent('企业内部')
    expect(screen.getByTestId('installed-plugin-row-59')).toHaveClass('min-h-[76px]')
  })

  test('falls back to bundled brand icons when the plugin has no logo metadata', () => {
    render(<InstalledPluginRow plugin={createPlugin()} onToggle={vi.fn()} onUninstall={vi.fn()} />)

    expect(screen.getByTestId('installed-plugin-logo-59')).toHaveAttribute(
      'src',
      '/plugin-icons/github.svg'
    )
    expect(screen.getByTestId('installed-plugin-logo-frame-59')).toHaveClass('plugin-logo-fallback')
  })

  test('uses the plugin initial when no logo metadata and no known plugin key', () => {
    render(
      <InstalledPluginRow
        plugin={createPlugin({ pluginKey: 'unknown-plugin' })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByTestId('installed-plugin-logo-59')).toHaveTextContent('G')
    expect(screen.getByTestId('installed-plugin-logo-frame-59')).toHaveAttribute(
      'data-plugin-distribution',
      'workspace'
    )
  })

  test('treats the bundled Wework lightning asset as a missing logo', () => {
    render(
      <InstalledPluginRow
        plugin={createPlugin({ logo: '/plugin-icons/wework.svg', pluginKey: 'review' })}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByTestId('installed-plugin-logo-59')).toHaveTextContent('G')
  })

  test('uses the switch only for enablement and keeps uninstall in the more menu', () => {
    const onToggle = vi.fn()
    const onUninstall = vi.fn()
    render(
      <InstalledPluginRow plugin={createPlugin()} onToggle={onToggle} onUninstall={onUninstall} />
    )

    fireEvent.click(screen.getByTestId('installed-plugin-toggle-59'))

    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onUninstall).not.toHaveBeenCalled()
    expect(screen.getByTestId('installed-plugin-toggle-59')).toHaveAccessibleName('停用插件 GitHub')

    fireEvent.click(screen.getByTestId('installed-plugin-actions-59'))
    fireEvent.click(screen.getByTestId('installed-plugin-uninstall-59'))

    expect(onUninstall).toHaveBeenCalledTimes(1)
  })

  test('hides the enable switch for shared recipient plugins', () => {
    const marketplaceItem = {
      accessRole: 'recipient',
      ownerDisplayName: '明德',
    } as PluginMarketplaceItem

    render(
      <InstalledPluginRow
        plugin={createPlugin()}
        marketplaceItem={marketplaceItem}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.queryByTestId('installed-plugin-toggle-59')).not.toBeInTheDocument()
    expect(screen.getByText(/创建者 明德 · 定向分享 · 仅可使用/)).toBeInTheDocument()
  })

  test('replaces row actions with uninstall progress while the request is pending', () => {
    render(
      <InstalledPluginRow
        plugin={createPlugin()}
        onTry={vi.fn()}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
        isUninstalling
      />
    )

    expect(screen.getByTestId('installed-plugin-uninstalling-59')).toHaveTextContent('正在卸载')
    expect(screen.queryByTestId('installed-plugin-try-59')).not.toBeInTheDocument()
    expect(screen.queryByTestId('installed-plugin-toggle-59')).not.toBeInTheDocument()
    expect(screen.queryByTestId('installed-plugin-actions-59')).not.toBeInTheDocument()
  })

  test('lists share before publish and uses custom labels', () => {
    const onPublish = vi.fn()
    const onShare = vi.fn()
    render(
      <InstalledPluginRow
        plugin={createPlugin()}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
        onPublish={onPublish}
        publishLabel="发布新版本"
        onShare={onShare}
        shareLabel="管理权限"
      />
    )

    fireEvent.click(screen.getByTestId('installed-plugin-actions-59'))
    const share = screen.getByTestId('installed-plugin-share-59')
    const publish = screen.getByTestId('installed-plugin-publish-59')
    expect(share).toHaveTextContent('管理权限')
    expect(publish).toHaveTextContent('发布新版本')
    expect(share.compareDocumentPosition(publish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(share)
    expect(onShare).toHaveBeenCalledTimes(1)
  })
})

describe('buildInstalledPluginSubtitle', () => {
  test('returns share recipient summary when the plugin is shared to the viewer', () => {
    const plugin = createPlugin()
    const marketplaceItem = {
      accessRole: 'recipient',
      ownerDisplayName: '明德',
    } as PluginMarketplaceItem

    expect(
      buildInstalledPluginSubtitle(plugin, marketplaceItem, (_key, fallback) => fallback)
    ).toBe('创建者 明德 · 定向分享 · 仅可使用')
  })
})
