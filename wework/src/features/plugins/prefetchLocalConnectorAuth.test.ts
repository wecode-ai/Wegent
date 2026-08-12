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
  clearLocalConnectorAuthPrefetchCache,
  peekWarmedLocalConnectorAuthPlugins,
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
    clearLocalConnectorAuthPrefetchCache()
    listInstalledPlugins.mockReset()
    readInstalledPluginDetail.mockReset()
    localConnectorAuthHealthMock.mockReset()
    localConnectorAuthHealthMock.mockResolvedValue({ status: 'logged_out' })
  })

  test('keeps previously warmed connector detail when prefetching another plugin', async () => {
    const pluginA = barePlugin('plugin-a', '1')
    const pluginB = barePlugin('plugin-b', '2')
    const detailedA = detailedPlugin('plugin-a', '1', 'connector-a')
    const detailedB = detailedPlugin('plugin-b', '2', 'connector-b')

    listInstalledPlugins.mockResolvedValue({ items: [pluginA, pluginB] })
    readInstalledPluginDetail.mockImplementation(async (plugin: InstalledPlugin) => {
      if (plugin.spec.source.pluginKey === 'plugin-a') return detailedA
      if (plugin.spec.source.pluginKey === 'plugin-b') return detailedB
      return plugin
    })

    await prefetchLocalConnectorAuthForPluginNames(['plugin-a'])
    const afterA = peekWarmedLocalConnectorAuthPlugins(['plugin-a'])
    expect(
      afterA?.find(p => p.spec.source.pluginKey === 'plugin-a')?.spec.components.connectors
    ).toHaveLength(1)

    await prefetchLocalConnectorAuthForPluginNames(['plugin-b'])
    const afterBoth = peekWarmedLocalConnectorAuthPlugins(['plugin-a', 'plugin-b'])
    expect(afterBoth).not.toBeNull()
    expect(
      afterBoth?.find(p => p.spec.source.pluginKey === 'plugin-a')?.spec.components.connectors
    ).toHaveLength(1)
    expect(
      afterBoth?.find(p => p.spec.source.pluginKey === 'plugin-b')?.spec.components.connectors
    ).toHaveLength(1)
  })

  test('does not mark a name warm when detail enrich fails', async () => {
    const pluginA = barePlugin('plugin-a', '1')
    // Summaries sometimes list a connector shell without localAuth; enrich must
    // succeed before the name is considered warm.
    pluginA.spec.components.connectors = [{ slug: 'connector-a', authPolicy: 'on_install' }]
    listInstalledPlugins.mockResolvedValue({ items: [pluginA] })
    readInstalledPluginDetail.mockRejectedValue(new Error('plugin/read failed'))

    await prefetchLocalConnectorAuthForPluginNames(['plugin-a'])
    expect(peekWarmedLocalConnectorAuthPlugins(['plugin-a'])).toBeNull()
  })
})
