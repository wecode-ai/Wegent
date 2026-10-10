import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'

const { listInstalledPlugins, readInstalledPluginDetail, localConnectorAuthHealthMock } =
  vi.hoisted(() => ({
    listInstalledPlugins: vi.fn(),
    readInstalledPluginDetail: vi.fn(),
    localConnectorAuthHealthMock: vi.fn(),
  }))

vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => ({
    listInstalledPlugins,
    readInstalledPluginDetail,
  }),
}))

vi.mock('@/api/local/localConnectorAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/local/localConnectorAuth')>()
  return {
    ...actual,
    localConnectorAuthHealth: (...args: unknown[]) => localConnectorAuthHealthMock(...args),
  }
})

import {
  loadLocalConnectorAuthPlugins,
  prefetchLocalConnectorAuthForPluginNames,
} from '@/features/plugins/prefetchLocalConnectorAuth'

function barePlugin(pluginKey: string, id: string): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: pluginKey, namespace: 'wegent', labels: { id } },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'marketplace',
        pluginKey,
        marketplace: 'wegent',
      },
      displayName: pluginKey,
      description: pluginKey,
      version: '1.0.0',
      installState: 'installed',
      enabled: true,
      manifest: {},
      components: {
        skills: [],
        commands: [],
        agents: [],
        apps: [],
        hooks: [],
        mcps: [],
        connectors: [],
        lsps: [],
        monitors: [],
        bins: [],
      },
    },
    status: { state: 'Ready' },
  }
}

function detailedPlugin(pluginKey: string, id: string, connectorSlug: string): InstalledPlugin {
  const bare = barePlugin(pluginKey, id)
  return {
    ...bare,
    spec: {
      ...bare.spec,
      components: {
        ...bare.spec.components,
        connectors: [
          {
            slug: connectorSlug,
            authPolicy: 'on_install',
            localAuth: {
              kind: 'local_qr',
              health: ['scripts/auth.sh', 'health'],
              start: ['scripts/auth.sh', 'start'],
              poll: ['scripts/auth.sh', 'poll'],
            },
          },
        ],
      },
    },
  }
}

describe('prefetchLocalConnectorAuthForPluginNames', () => {
  beforeEach(() => {
    listInstalledPlugins.mockReset()
    readInstalledPluginDetail.mockReset()
    localConnectorAuthHealthMock.mockReset()
    localConnectorAuthHealthMock.mockResolvedValue({ status: 'logged_out' })
  })

  test('reads only mentioned manifests and does not retain a separate snapshot', async () => {
    const pluginA = barePlugin('plugin-a', '1')
    const pluginB = barePlugin('plugin-b', '2')
    listInstalledPlugins.mockResolvedValue({ items: [pluginA, pluginB] })
    readInstalledPluginDetail.mockImplementation(async (plugin: InstalledPlugin) =>
      detailedPlugin(plugin.spec.source.pluginKey, '1', 'connector-current')
    )
    await prefetchLocalConnectorAuthForPluginNames(['plugin-a'])
    expect(readInstalledPluginDetail).toHaveBeenCalledExactlyOnceWith(pluginA)
    await loadLocalConnectorAuthPlugins(['plugin-b'])
    expect(readInstalledPluginDetail).toHaveBeenLastCalledWith(pluginB)
    expect(listInstalledPlugins).toHaveBeenCalledWith({ requireComplete: true })
  })

  test('replaces an old localAuth connector after an upgrade, including removal', async () => {
    const oldPlugin = detailedPlugin('dingtalk', '1', 'dingtalk')
    const upgraded = detailedPlugin('dingtalk', '1', 'dingtalk-local')
    upgraded.spec.version = '0.3.4'
    listInstalledPlugins.mockResolvedValue({ items: [oldPlugin] })
    readInstalledPluginDetail.mockResolvedValueOnce(oldPlugin).mockResolvedValueOnce(upgraded)
    await prefetchLocalConnectorAuthForPluginNames(['dingtalk'])
    const current = await loadLocalConnectorAuthPlugins(['dingtalk'])
    expect(current[0].spec.components.connectors?.[0].slug).toBe('dingtalk-local')
    const withoutLocalAuth = barePlugin('dingtalk', '1')
    readInstalledPluginDetail.mockResolvedValueOnce(withoutLocalAuth)
    expect(
      (await loadLocalConnectorAuthPlugins(['dingtalk']))[0].spec.components.connectors
    ).toEqual([])
  })

  test('reports detail read errors instead of reusing stale localAuth', async () => {
    listInstalledPlugins.mockResolvedValue({ items: [detailedPlugin('plugin-a', '1', 'old')] })
    readInstalledPluginDetail.mockRejectedValue(new Error('plugin/read failed'))
    await expect(loadLocalConnectorAuthPlugins(['plugin-a'])).rejects.toThrow('plugin/read failed')
  })
})
