import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { PluginManagementWorkspace } from './PluginManagementWorkspace'
import type { InstalledPlugin } from '@/types/api'

function makeInstalledPlugin(id: number, runtime: 'claudecode' | 'codex'): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: `superpowers-${runtime}`,
      namespace: 'default',
      labels: { id: String(id) },
    },
    spec: {
      source: {
        type: 'system',
        providerKey: runtime === 'codex' ? 'codex' : 'claude-code',
        pluginKey: 'superpowers',
        catalogItemId: '100',
        systemPluginId: runtime === 'codex' ? 101 : 100,
        runtime,
      },
      displayName: 'superpowers',
      description:
        'Core skills library for Claude Code: TDD, debugging, collaboration patterns, and proven techniques',
      version: '5.0.7',
      runtime,
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: { name: 'superpowers' },
      components: {
        skills: [{ name: 'plan', description: 'Plan work', path: 'skills/plan/SKILL.md' }],
        commands: [{ name: 'test', path: 'commands/test.md' }],
        agents: [],
        hooks: [],
        mcps: [],
        lsps: [],
        monitors: [],
        bins: [],
        settings: null,
      },
      packageRef: {
        storageKey: `skill-binaries/${id}`,
        checksum: `sha256:${id}`,
        sizeBytes: 100,
      },
      sourcePayload: null,
    },
    status: { state: 'Available' },
  }
}

function mockManagementFetch(installedPlugins: InstalledPlugin[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const requestUrl = new URL(url, 'http://localhost')
      if (requestUrl.pathname === '/api/plugins/installed') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: installedPlugins }),
        })
      }
      if (requestUrl.pathname.startsWith('/api/plugins/installed/')) {
        const id = Number(requestUrl.pathname.split('/').at(-1))
        const plugin = installedPlugins.find(item => item.metadata.labels?.id === String(id))
        return Promise.resolve({
          ok: true,
          status: init?.method === 'DELETE' ? 204 : 200,
          json: () => Promise.resolve(plugin ?? {}),
        })
      }
      if (requestUrl.pathname === '/api/mcps/installed') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        })
      }
      if (requestUrl.pathname === '/api/system-skills/installed') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        })
      }
      if (requestUrl.pathname === '/api/mcp-providers') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ providers: [] }),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
    })
  )
}

describe('PluginManagementWorkspace', () => {
  beforeEach(() => {
    mockManagementFetch()
  })

  test('removes user plugin upload entry from plugin management', async () => {
    render(<PluginManagementWorkspace />)

    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    expect(screen.queryByTestId('plugin-management-upload-plugin-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-management-create-button'))

    expect(screen.queryByTestId('plugins-create-plugin-option')).not.toBeInTheDocument()
  })

  test('groups installed runtime variants as one logical plugin', async () => {
    mockManagementFetch([
      makeInstalledPlugin(501, 'claudecode'),
      makeInstalledPlugin(502, 'codex'),
      makeInstalledPlugin(503, 'claudecode'),
    ])

    render(<PluginManagementWorkspace />)

    expect(await screen.findByText('superpowers')).toBeInTheDocument()
    expect(screen.getAllByTestId(/installed-plugin-row-/)).toHaveLength(1)

    await userEvent.click(screen.getByTestId('installed-plugin-toggle-501'))

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/501',
      expect.objectContaining({ method: 'PUT' })
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/502',
      expect.objectContaining({ method: 'PUT' })
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/503',
      expect.objectContaining({ method: 'PUT' })
    )
  })
})
