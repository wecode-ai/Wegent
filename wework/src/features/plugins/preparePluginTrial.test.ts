import { describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import { preparePluginTrial, PluginInstallationInspectionError } from './preparePluginTrial'

function plugin(marketplace = 'wegent'): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'wegent-sites', labels: { id: '101' } },
    spec: {
      source: { type: 'marketplace', pluginKey: 'wegent-sites', marketplace },
      displayName: 'Sites',
      installState: 'installed',
      enabled: true,
      manifest: {},
      components: { skills: [], commands: [], agents: [], hooks: [], mcps: [], lsps: [] },
    },
    status: { state: 'enabled' },
  }
}

function options() {
  const installed = plugin()
  installed.status.devices = [{ deviceId: 'local-device', state: 'installed' }]
  return {
    pluginName: 'wegent-sites',
    marketplaceName: 'wegent',
    deviceId: 'local-device',
    readLocalInstalledPlugins: vi.fn().mockResolvedValue({ items: [], deviceId: 'local-device' }),
    listInstalledPlugins: vi.fn().mockResolvedValue({ items: [] }),
    ensureInstalled: vi.fn().mockResolvedValue({ plugin: installed }),
    onInstalling: vi.fn(),
  }
}

describe('preparePluginTrial', () => {
  test('uses local membership without cloud inspection or installation', async () => {
    const input = options()
    const installed = plugin()
    input.readLocalInstalledPlugins.mockResolvedValue({
      items: [installed],
      deviceId: 'local-device',
    })
    expect(await preparePluginTrial(input)).toBe(installed)
    expect(input.listInstalledPlugins).not.toHaveBeenCalled()
    expect(input.ensureInstalled).not.toHaveBeenCalled()
    expect(input.onInstalling).not.toHaveBeenCalled()
  })

  test.each(['other-device', undefined])(
    'does not treat inventory from %s as target-device confirmation',
    async deviceId => {
      const input = options()
      input.readLocalInstalledPlugins.mockResolvedValue({ items: [plugin()], deviceId })
      await preparePluginTrial(input)
      expect(input.listInstalledPlugins).toHaveBeenCalledWith('local-device')
      expect(input.ensureInstalled).toHaveBeenCalledWith('wegent-sites', 'local-device')
    }
  )

  test.each(['missing', 'disabled', 'wrong-marketplace'])(
    'installs when the local plugin is %s, even if cloud state is stale',
    async reason => {
      const input = options()
      const installed = plugin(reason === 'wrong-marketplace' ? 'wework' : 'wegent')
      installed.spec.enabled = reason !== 'disabled'
      input.readLocalInstalledPlugins.mockResolvedValue({
        items: reason === 'missing' ? [] : [installed],
        deviceId: 'local-device',
      })
      input.listInstalledPlugins.mockResolvedValue({ items: [plugin()] })
      await preparePluginTrial(input)
      expect(input.listInstalledPlugins).not.toHaveBeenCalled()
      expect(input.ensureInstalled).toHaveBeenCalledOnce()
    }
  )

  test.each(['local', 'cloud'])(
    'does not turn a %s inspection failure into an install',
    async source => {
      const input = options()
      if (source === 'local')
        input.readLocalInstalledPlugins.mockRejectedValue(new Error('Unavailable'))
      else {
        input.readLocalInstalledPlugins.mockResolvedValue({ items: [], deviceId: 'other-device' })
        input.listInstalledPlugins.mockRejectedValue(new Error('HTTP 500'))
      }
      await expect(preparePluginTrial(input)).rejects.toBeInstanceOf(
        PluginInstallationInspectionError
      )
      expect(input.ensureInstalled).not.toHaveBeenCalled()
      expect(input.onInstalling).not.toHaveBeenCalled()
    }
  )

  test('reuses cloud confirmation only for the selected device', async () => {
    const input = options()
    input.readLocalInstalledPlugins.mockResolvedValue({ items: [], deviceId: 'other-device' })
    const installed = plugin()
    installed.status.devices = [{ deviceId: 'local-device', state: 'installed' }]
    input.listInstalledPlugins.mockResolvedValue({ items: [installed] })
    expect(await preparePluginTrial(input)).toBe(installed)
    expect(input.ensureInstalled).not.toHaveBeenCalled()
  })
})
