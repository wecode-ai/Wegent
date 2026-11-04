import '@/i18n'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
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
  test('uses the plugin name initial when the plugin has no logo metadata', () => {
    render(<InstalledPluginRow plugin={createPlugin()} onToggle={vi.fn()} onUninstall={vi.fn()} />)

    expect(screen.getByTestId('installed-plugin-logo-59')).toHaveTextContent('G')
    expect(screen.getByTestId('installed-plugin-logo-59').tagName).toBe('SPAN')
    expect(screen.getByTestId('installed-plugin-logo-frame-59')).toHaveClass('plugin-logo-fallback')
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
