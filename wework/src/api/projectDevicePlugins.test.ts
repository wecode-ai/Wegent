import { CODEX_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import { describe, expect, test, vi } from 'vitest'
import * as localPlugins from './local/codexPlugins'
import { toInstalledPlugin } from '@wegent/chat-core/codex-installed-plugins'
import {
  createLocalProjectDevicePluginApi,
  createRemoteProjectDevicePluginApi,
} from './projectDevicePlugins'

const item = {
  id: 'quality@team',
  name: 'quality',
  displayName: 'Quality',
  manifest: { id: 'quality@team', marketplaceId: 'team', marketplacePath: '/device/plugins' },
}

describe('device project plugins', () => {
  test('refreshes installed membership after an external uninstall', async () => {
    let installed = true
    const request = vi.fn(async (method: string) => ({
      marketplaces: [
        {
          name: 'team',
          path: '/device/plugins',
          plugins:
            method === 'plugin/installed' && !installed
              ? []
              : [{ id: 'quality@team', name: 'quality', installed, enabled: installed }],
        },
      ],
    }))
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    expect((await api.readState({ refresh: true })).marketplaceItems[0].installed).toBe(true)
    installed = false
    expect((await api.readState({ refresh: true })).marketplaceItems[0].installed).toBe(false)
  })
  test('keeps separate device inventories and disables only newly installed plugins', async () => {
    const requestA = vi.fn(async (method: string) =>
      method === 'plugin/installed'
        ? { marketplaces: [] }
        : {
            marketplaces: [
              {
                name: 'team',
                path: '/device/plugins',
                plugins: [
                  { id: 'quality@team', name: 'quality', installed: false, enabled: false },
                ],
              },
            ],
          }
    )
    const requestB = vi.fn(async () => ({ marketplaces: [] }))
    const a = createRemoteProjectDevicePluginApi('a', requestA as never)
    const b = createRemoteProjectDevicePluginApi('b', requestB as never)
    expect((await a.readState()).deviceId).toBe('a')
    expect((await b.readState()).marketplaceItems).toEqual([])
    await a.installAvailablePlugin(item as never)
    expect(requestA).toHaveBeenCalledWith('plugin/install', {
      marketplacePath: '/device/plugins',
      remoteMarketplaceName: null,
      pluginName: 'quality',
    })
    expect(requestA).toHaveBeenCalledWith('config/value/write', {
      keyPath: 'plugins."quality@team".enabled',
      value: false,
      mergeStrategy: 'upsert',
    })
    expect(requestB).not.toHaveBeenCalledWith('plugin/install', expect.anything())
  })

  test('preserves a globally enabled plugin when a stale catalog row says uninstalled', async () => {
    const request = vi.fn(async () => ({
      marketplaces: [
        {
          name: 'team',
          path: '/device/plugins',
          plugins: [{ id: 'quality@team', name: 'quality', installed: true, enabled: true }],
        },
      ],
    }))
    const api = createRemoteProjectDevicePluginApi('device', request as never)
    const installed = await api.installAvailablePlugin(item as never)
    expect(installed.spec.enabled).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('plugin/installed', {})
  })

  test('resolves a connector installation id through the target device plugin read', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin/installed') return { marketplaces: [] }
      if (method === 'plugin/read')
        return {
          plugin: {
            summary: {
              id: 'plugin_connector_quality',
              name: 'quality',
              installed: false,
              enabled: false,
            },
          },
        }
      return { authPolicy: 'ON_USE', appsNeedingAuth: [] }
    })
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    await api.installAvailablePlugin({
      ...item,
      manifest: { id: 'quality@team', marketplaceId: 'team', marketplacePath: null },
    } as never)
    expect(request).toHaveBeenCalledWith('plugin/read', {
      marketplacePath: null,
      remoteMarketplaceName: 'team',
      pluginName: 'quality',
    })
    expect(request).toHaveBeenCalledWith('plugin/install', {
      marketplacePath: null,
      remoteMarketplaceName: 'team',
      pluginName: 'plugin_connector_quality',
    })
  })

  test('preserves enabled personal plugins across equivalent marketplace identities', async () => {
    const request = vi.fn(async () => ({
      marketplaces: [
        {
          name: CODEX_PERSONAL_MARKETPLACE_ID,
          path: '/device/plugins',
          plugins: [
            {
              id: `QUALITY@${CODEX_PERSONAL_MARKETPLACE_ID}`,
              name: 'QUALITY',
              installed: true,
              enabled: true,
            },
          ],
        },
      ],
    }))
    const api = createRemoteProjectDevicePluginApi('remote', request as never)
    const installed = await api.installAvailablePlugin({
      ...item,
      manifest: { marketplaceId: 'wework-personal' },
    } as never)
    expect(installed.spec.enabled).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })

  test('disables a newly accepted local install without rediscovering stale membership', async () => {
    const installed = toInstalledPlugin(
      { name: 'team', path: '/device/plugins', plugins: [] },
      { id: 'quality@team', name: 'quality', installed: true, enabled: true },
      undefined,
      key => key
    )
    const local = {
      readState: vi.fn().mockResolvedValue({ installedPlugins: [] }),
      installAvailablePlugin: vi.fn().mockResolvedValue(installed),
      updateInstalledPlugin: vi.fn().mockRejectedValue(new Error('Stale membership')),
    }
    const create = vi
      .spyOn(localPlugins, 'createLocalCodexPluginApi')
      .mockReturnValue(local as never)
    const write = vi.spyOn(localPlugins, 'writeCodexPluginEnabled').mockResolvedValue(undefined)
    try {
      const plugin = await createLocalProjectDevicePluginApi().installAvailablePlugin(item as never)
      expect(plugin.spec.enabled).toBe(false)
      expect(write).toHaveBeenCalledWith('quality@team', false)
      expect(local.updateInstalledPlugin).not.toHaveBeenCalled()
    } finally {
      create.mockRestore()
      write.mockRestore()
    }
  })
})
