import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { InstalledPlugin } from '@/types/api'
import { InstalledPluginRow, type InstalledPluginItem } from './PluginManagementRows'

function createPlugin(logo?: string): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'wegent.ai/v1',
    kind: 'InstalledPlugin',
    metadata: {},
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent',
        pluginKey: 'github',
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
      interface: logo ? { logo } : null,
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
        plugin={createPlugin('data:image/png;base64,cG5n')}
        onToggle={vi.fn()}
        onUninstall={vi.fn()}
      />
    )

    expect(screen.getByTestId('installed-plugin-logo-59')).toHaveAttribute(
      'src',
      'data:image/png;base64,cG5n'
    )
    expect(screen.getByTestId('installed-plugin-origin-59')).toHaveTextContent('企业内部')
  })

  test('keeps the generic icon when the plugin has no logo', () => {
    const { container } = render(
      <InstalledPluginRow plugin={createPlugin()} onToggle={vi.fn()} onUninstall={vi.fn()} />
    )

    expect(screen.queryByTestId('installed-plugin-logo-59')).not.toBeInTheDocument()
    expect(container.querySelector('svg')).toBeInTheDocument()
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
})
