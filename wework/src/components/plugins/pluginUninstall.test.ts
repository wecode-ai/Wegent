import { describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import { LocalPluginUninstallCleanupError } from '@/api/local/pluginUninstallError'
import { uninstallPluginIdentities } from './pluginUninstall'

function installedPlugin(origin: 'created' | 'market'): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'dev-tools', namespace: 'default', labels: { id: 'local-plugin' } },
    spec: {
      source: {
        type: origin === 'created' ? 'local' : 'marketplace',
        providerKey: 'wegent',
        pluginKey: 'dev-tools',
        catalogItemId: '71',
        marketplace: origin === 'created' ? 'wework-personal' : 'wegent',
      },
      origin,
      pluginId: origin === 'market' ? 71 : null,
      releaseId: origin === 'market' ? 82 : null,
      installState: 'installed',
      enabled: true,
      sourceProvider: origin === 'created' ? 'codex' : 'wegent',
      sourceLabel: '',
      displayName: 'Dev Tools',
      description: '',
      componentStates: {},
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
      packageRef: null,
      sourcePayload:
        origin === 'created'
          ? { cloudPluginId: 71, cloudInstalledPluginId: 104 }
          : { localId: 104 },
    },
    status: { state: 'installed' },
  }
}

describe('uninstallPluginIdentities', () => {
  test('removes the cloud installation before a linked local plugin', async () => {
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    const outcome = await uninstallPluginIdentities(
      installedPlugin('created'),
      'local-plugin',
      'device-1',
      {
        uninstallCloud,
        uninstallLocal,
      }
    )

    expect(outcome.warnings).toEqual([])
    expect(uninstallCloud).toHaveBeenCalledWith(104, 'device-1')
    expect(uninstallLocal).toHaveBeenCalledWith('local-plugin')
    expect(uninstallCloud.mock.invocationCallOrder[0]).toBeLessThan(
      uninstallLocal.mock.invocationCallOrder[0]
    )
  })

  test('only calls the cloud API for a cloud-managed plugin', async () => {
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await uninstallPluginIdentities(installedPlugin('market'), 104, 'device-1', {
      uninstallCloud,
      uninstallLocal,
    })

    expect(uninstallCloud).toHaveBeenCalledWith(104, 'device-1')
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('does not remove the local plugin when cloud uninstall fails', async () => {
    const cloudError = new Error('Cloud unavailable')
    const uninstallCloud = vi.fn().mockRejectedValue(cloudError)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await expect(
      uninstallPluginIdentities(installedPlugin('created'), 'local-plugin', 'device-1', {
        uninstallCloud,
        uninstallLocal,
      })
    ).rejects.toThrow('Cloud unavailable')

    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('does not remove the local plugin when the cloud install id is missing', async () => {
    const plugin = installedPlugin('created')
    plugin.spec.sourcePayload = { cloudPluginId: 71 }
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockResolvedValue(undefined)

    await expect(
      uninstallPluginIdentities(plugin, 'local-plugin', 'device-1', {
        uninstallCloud,
        uninstallLocal,
      })
    ).rejects.toThrow(/account install id is unavailable/i)

    expect(uninstallCloud).not.toHaveBeenCalled()
    expect(uninstallLocal).not.toHaveBeenCalled()
  })

  test('reports link cleanup failure after a completed local uninstall', async () => {
    const cleanupError = new LocalPluginUninstallCleanupError('Cloud link cleanup failed')
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockRejectedValue(cleanupError)

    const outcome = await uninstallPluginIdentities(
      installedPlugin('created'),
      'local-plugin',
      'device-1',
      {
        uninstallCloud,
        uninstallLocal,
      }
    )

    expect(outcome.warnings).toEqual([cleanupError])
  })

  test('rejects when the local plugin itself could not be removed', async () => {
    const uninstallCloud = vi.fn().mockResolvedValue(undefined)
    const uninstallLocal = vi.fn().mockRejectedValue(new Error('Local uninstall failed'))

    await expect(
      uninstallPluginIdentities(installedPlugin('created'), 'local-plugin', 'device-1', {
        uninstallCloud,
        uninstallLocal,
      })
    ).rejects.toThrow('Local uninstall failed')
  })
})
