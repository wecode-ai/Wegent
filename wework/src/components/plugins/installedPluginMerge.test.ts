import { describe, expect, test } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import {
  hasLocalCodexMaterialization,
  isCloudManagedInstalledPlugin,
  mergeInstalledPlugins,
  mergeLocalInstalledWithStorePackages,
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
  version?: string
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
      version: overrides?.version,
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

  test('uses the local materialized version when a cloud update failed', () => {
    const cloud = cloudPlugin({ installState: 'update_available' })
    cloud.status.devices = [
      {
        deviceId: 'current-device',
        desiredReleaseId: 6,
        actualReleaseId: 5,
        state: 'failed',
        attemptCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]
    const local = localCodexPlugin({
      id: 'github-local',
      name: 'github',
      pluginKey: 'github',
      marketplace: 'wegent',
      version: '0.9.0',
    })

    const merged = mergeInstalledPlugins([cloud], [local], 'current-device')

    expect(merged).toHaveLength(1)
    expect(merged[0]?.spec.displayName).toBe('GitHub')
    expect(merged[0]?.spec.releaseId).toBe(5)
    expect(merged[0]?.spec.version).toBe('0.9.0')
    expect(merged[0]?.spec.installState).toBe('update_available')
    expect(merged[0]?.spec.sourcePayload).toMatchObject({
      releaseId: 5,
      cloudInstalledPluginId: '4',
    })
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
    expect(merged[0]?.spec.sourcePayload).toMatchObject({ localPresent: true })
  })

  test('keeps a local Codex package when the cloud device row is still pending', () => {
    const cloud = cloudPlugin({ installState: 'not_installed', version: '0.2.9' })
    cloud.status.devices = [
      {
        deviceId: 'current-device',
        desiredReleaseId: 6,
        actualReleaseId: null,
        state: 'pending',
        attemptCount: 0,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]
    const local = localCodexPlugin({
      id: 'github-local',
      name: 'github',
      pluginKey: 'github',
      marketplace: 'wegent',
      version: '0.2.8',
    })

    const merged = mergeInstalledPlugins([cloud], [local], 'current-device')

    expect(merged).toHaveLength(1)
    expect(hasLocalCodexMaterialization(merged[0]!)).toBe(true)
    expect(merged[0]?.spec.pluginId).toBe(4)
    expect(merged[0]?.metadata.labels).toMatchObject({ id: 4 })
    expect(merged[0]?.spec.sourcePayload).toMatchObject({
      localPresent: true,
      cloudInstalledPluginId: '4',
      localVersion: '0.2.8',
    })
    expect(merged[0]?.spec.sourcePayload).not.toHaveProperty('localId')
    expect(merged[0]?.status.devices?.[0]?.state).toBe('pending')
  })

  test('matches a wegent store directory to the cloud plugin even when Codex uses the folder name', () => {
    const cloud = cloudPlugin({
      id: 267250,
      installState: 'not_installed',
      version: '0.1.6',
    })
    cloud.metadata = {
      name: 'wegent-sites',
      namespace: 'default',
      labels: { id: 267250 },
    }
    cloud.spec.source = {
      ...cloud.spec.source,
      pluginKey: 'wegent-sites',
      catalogItemId: '267250',
    }
    cloud.status.devices = [
      {
        deviceId: 'current-device',
        desiredReleaseId: 6,
        actualReleaseId: null,
        state: 'pending',
        attemptCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]
    const local = localCodexPlugin({
      id: '267250-wegent-wegent-sites-0.1.6',
      name: '267250-wegent-wegent-sites-0.1.6',
      pluginKey: '267250-wegent-wegent-sites-0.1.6',
      marketplace: 'wegent',
      version: '0.1.6',
    })

    const merged = mergeInstalledPlugins([cloud], [local], 'current-device')

    expect(merged).toHaveLength(1)
    expect(hasLocalCodexMaterialization(merged[0]!)).toBe(true)
    expect(merged[0]?.spec.pluginId).toBe(267250)
  })

  test('dedupes codex membership and store ZIP for the same cloud plugin', () => {
    const cloud = cloudPlugin({
      id: 268634,
      displayName: 'Code Review',
      installState: 'update_available',
      version: '0.1.3',
    })
    cloud.metadata = {
      name: 'code-review',
      namespace: 'default',
      labels: { id: 268634 },
    }
    cloud.spec.source = {
      ...cloud.spec.source,
      pluginKey: 'code-review',
      catalogItemId: '268634',
    }
    cloud.status.devices = [
      {
        deviceId: 'current-device',
        desiredReleaseId: 7,
        actualReleaseId: 6,
        state: 'pending',
        attemptCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]
    const codexMembership = localCodexPlugin({
      id: 'code-review',
      name: 'code-review',
      pluginKey: 'code-review',
      marketplace: 'wegent',
      version: '0.1.2',
    })
    const storePackage = localCodexPlugin({
      id: '268634-wegent-code-review-0.1.2',
      name: '268634-wegent-code-review-0.1.2',
      pluginKey: '268634-wegent-code-review-0.1.2',
      marketplace: 'wegent',
      version: '0.1.2',
    })

    const merged = mergeInstalledPlugins([cloud], [codexMembership, storePackage], 'current-device')

    expect(merged).toHaveLength(1)
    expect(merged[0]?.spec.displayName).toBe('Code Review')
    expect(merged[0]?.spec.pluginId).toBe(268634)
    expect(hasLocalCodexMaterialization(merged[0]!)).toBe(true)
    expect(merged[0]?.spec.sourcePayload).toMatchObject({
      localPresent: true,
      localVersion: '0.1.2',
    })
  })

  test('folds a disk store package that Codex membership omitted', () => {
    const local = localCodexPlugin({ id: 'documents-local', name: 'documents' })
    const store = localCodexPlugin({
      id: '269646-wegent-sina-email-0.1.11',
      name: 'sina-email',
      pluginKey: 'sina-email',
      marketplace: 'wegent',
      version: '0.1.11',
    })

    const merged = mergeLocalInstalledWithStorePackages([local], [store, local])

    expect(merged).toHaveLength(2)
    expect(merged.map(item => item.metadata.labels?.id)).toEqual([
      'documents-local',
      '269646-wegent-sina-email-0.1.11',
    ])
  })

  test('keeps same-name store packages from different marketplaces', () => {
    const bundled = localCodexPlugin({
      id: 'documents-bundled',
      name: 'documents',
      pluginKey: 'documents',
      marketplace: 'openai-bundled',
    })
    const remote = localCodexPlugin({
      id: 'documents-remote',
      name: 'documents',
      pluginKey: 'documents',
      marketplace: 'openai-curated-remote',
    })

    const merged = mergeLocalInstalledWithStorePackages([bundled], [remote])

    expect(merged).toEqual([bundled, remote])
  })

  test('does not append a manifest-backed store package already listed by Codex', () => {
    const membership = localCodexPlugin({
      id: 'sina-email',
      name: 'sina-email',
      pluginKey: 'sina-email',
      marketplace: 'wegent',
      version: '0.1.11',
    })
    const store = localCodexPlugin({
      id: '269646-wegent-sina-email-0.1.11',
      name: 'sina-email',
      pluginKey: 'sina-email',
      marketplace: 'wegent',
      version: '0.1.11',
    })

    expect(mergeLocalInstalledWithStorePackages([membership], [store])).toEqual([membership])
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

describe('hasLocalCodexMaterialization', () => {
  test('treats a Codex package and a cloud row with localPresent as materialized', () => {
    expect(hasLocalCodexMaterialization(localCodexPlugin())).toBe(true)
    expect(hasLocalCodexMaterialization(cloudPlugin())).toBe(false)
    const marked = cloudPlugin()
    marked.spec.sourcePayload = { localPresent: true }
    expect(hasLocalCodexMaterialization(marked)).toBe(true)
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
        cachedDeviceId: 'device-a',
        localDeviceId: 'device-b',
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
        cachedDeviceId: 'device-a',
        localDeviceId: 'device-b',
      })
    ).toEqual(cached)
  })

  test('uses peek installs when they belong to the cached current device', () => {
    expect(
      resolveProgressiveLocalInstalledRaw({
        hasCachedSnapshot: true,
        cachedInstalledRaw: cached,
        localInstalledRaw: peeked,
        localStateIsPeek: true,
        cachedDeviceId: 'current-device',
        localDeviceId: 'current-device',
      })
    ).toEqual(peeked)
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
