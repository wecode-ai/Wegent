import { describe, expect, test } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import {
  isCloudManagedInstalledPlugin,
  mergeInstalledPlugins,
  resolveProgressiveLocalInstalledRaw,
} from './installedPluginMerge'

function cloudPlugin(
  overrides?: Partial<InstalledPlugin['spec']> & { id?: number }
): InstalledPlugin {
  const id = overrides?.id ?? 4
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'github', namespace: 'default', labels: { id } },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent-market',
        pluginKey: 'github',
        catalogItemId: String(id),
      },
      origin: 'market',
      pluginId: id,
      releaseId: 6,
      installState: 'installed',
      enabled: true,
      sourceProvider: 'wegent',
      sourceLabel: 'Wegent 官方',
      displayName: 'GitHub',
      description: 'GitHub plugin',
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
      sourcePayload: null,
      ...overrides,
    },
    status: { state: 'installed' },
  }
}

function localCodexPlugin(overrides?: {
  id?: string
  name?: string
  pluginKey?: string
  marketplace?: string
}): InstalledPlugin {
  const id = overrides?.id ?? 'superpowers-local-id'
  const name = overrides?.name ?? 'superpowers'
  const marketplace = overrides?.marketplace ?? 'openai-bundled'
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name, namespace: marketplace, labels: { id } },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: marketplace,
        pluginKey: overrides?.pluginKey ?? name,
        catalogItemId: id,
        marketplace,
      },
      origin: 'market',
      sourceProvider: 'codex',
      sourceLabel: 'Codex 官方',
      displayName: name,
      description: `${name} plugin`,
      installState: 'installed',
      enabled: true,
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
      sourcePayload: { localId: null, marketplaceName: marketplace },
    },
    status: { state: 'enabled' },
  }
}

describe('mergeInstalledPlugins', () => {
  test('keeps local Codex installs when cloud installs are present', () => {
    const merged = mergeInstalledPlugins([cloudPlugin()], [localCodexPlugin()], 'current-device')

    expect(merged.map(item => item.spec.displayName)).toEqual(['GitHub', 'superpowers'])
  })

  test('keeps same-name plugins from a different marketplace', () => {
    const merged = mergeInstalledPlugins(
      [cloudPlugin()],
      [localCodexPlugin({ id: 'github-local', name: 'github', pluginKey: 'github' })],
      'current-device'
    )

    expect(merged).toHaveLength(2)
    expect(merged[0]?.spec.pluginId).toBe(4)
    expect(merged[1]?.spec.source.marketplace).toBe('openai-bundled')
  })

  test('prefers the cloud install over its local Wegent materialization', () => {
    const merged = mergeInstalledPlugins(
      [cloudPlugin()],
      [
        localCodexPlugin({
          id: 'github-local',
          name: 'github',
          pluginKey: 'github',
          marketplace: 'wegent',
        }),
      ],
      'current-device'
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]?.spec.pluginId).toBe(4)
  })

  test('prefers a locally created plugin linked to the same published cloud plugin', () => {
    const local = localCodexPlugin({
      id: 'dev-tools-local',
      name: 'dev-tools',
      pluginKey: 'dev-tools',
      marketplace: 'wework-personal',
    })
    local.spec.origin = 'created'
    local.spec.sourcePayload = {
      ...local.spec.sourcePayload,
      cloudPluginId: 4,
      cloudReleaseId: 6,
    }

    const merged = mergeInstalledPlugins(
      [cloudPlugin({ displayName: 'Dev Tools' })],
      [local],
      'current-device'
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]?.metadata.labels).toMatchObject({ id: 'dev-tools-local' })
    expect(merged[0]?.spec.origin).toBe('created')
    expect(merged[0]?.spec.sourcePayload).toMatchObject({
      cloudPluginId: 4,
      cloudInstalledPluginId: '4',
    })
  })

  test('keeps local Codex installs when there are no cloud installs', () => {
    const merged = mergeInstalledPlugins([], [localCodexPlugin()], 'current-device')
    expect(merged).toHaveLength(1)
    expect(merged[0]?.metadata.labels).toMatchObject({ id: 'superpowers-local-id' })
  })

  test('keeps marketplace installs that lack labels.id by plugin@marketplace identity', () => {
    const withoutLocalId: InstalledPlugin = {
      ...localCodexPlugin({
        id: '',
        name: 'desktop-e2e-plugin',
        pluginKey: 'desktop-e2e-plugin',
        marketplace: 'desktop-e2e-marketplace',
      }),
      metadata: {
        name: 'desktop-e2e-plugin',
        namespace: 'desktop-e2e-marketplace',
        labels: {},
      },
      spec: {
        ...localCodexPlugin({
          name: 'desktop-e2e-plugin',
          pluginKey: 'desktop-e2e-plugin',
          marketplace: 'desktop-e2e-marketplace',
        }).spec,
        sourcePayload: {
          localId: null,
          marketplaceName: 'desktop-e2e-marketplace',
          pluginName: 'desktop-e2e-plugin',
        },
      },
    }

    const merged = mergeInstalledPlugins([], [withoutLocalId], 'current-device')
    expect(merged).toHaveLength(1)
    expect(merged[0]?.spec.source.pluginKey).toBe('desktop-e2e-plugin')
  })
})

describe('isCloudManagedInstalledPlugin', () => {
  test('treats only numeric cloud pluginId as cloud-managed', () => {
    expect(isCloudManagedInstalledPlugin(cloudPlugin())).toBe(true)
    expect(isCloudManagedInstalledPlugin(localCodexPlugin())).toBe(false)
  })
})

describe('resolveProgressiveLocalInstalledRaw', () => {
  const cached = [cloudPlugin({ id: 1 })]
  const peeked = [localCodexPlugin()]
  const refreshed = [localCodexPlugin({ id: 'refreshed-local' })]

  test('keeps empty account cache authoritative over peek installs', () => {
    expect(
      resolveProgressiveLocalInstalledRaw({
        hasCachedSnapshot: true,
        cachedInstalledRaw: [],
        localInstalledRaw: peeked,
        localStateIsPeek: true,
      })
    ).toEqual([])
  })

  test('keeps non-empty account cache authoritative over peek installs', () => {
    expect(
      resolveProgressiveLocalInstalledRaw({
        hasCachedSnapshot: true,
        cachedInstalledRaw: cached,
        localInstalledRaw: peeked,
        localStateIsPeek: true,
      })
    ).toEqual(cached)
  })

  test('allows refreshed local reads to replace warm cache', () => {
    expect(
      resolveProgressiveLocalInstalledRaw({
        hasCachedSnapshot: true,
        cachedInstalledRaw: cached,
        localInstalledRaw: refreshed,
        localStateIsPeek: false,
      })
    ).toEqual(refreshed)
  })

  test('uses peek installs when the account cache is cold', () => {
    expect(
      resolveProgressiveLocalInstalledRaw({
        hasCachedSnapshot: false,
        cachedInstalledRaw: [],
        localInstalledRaw: peeked,
        localStateIsPeek: true,
      })
    ).toEqual(peeked)
  })
})
