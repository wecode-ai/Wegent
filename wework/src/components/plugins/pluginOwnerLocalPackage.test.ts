import { describe, expect, test } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import {
  findPackableCreatedPlugin,
  isPackableCreatedPlugin,
  marketplaceItemOwnsLocalCreatedPackage,
  resolveContinueEditingPluginKey,
} from './pluginOwnerLocalPackage'

function installedItem(overrides: {
  id: string
  origin: 'created' | 'market'
  pluginKey: string
  name?: string
  sourceType?: 'local' | 'marketplace'
}): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: overrides.pluginKey,
      namespace: 'default',
      labels: { id: overrides.id },
    },
    spec: {
      source: {
        type: overrides.sourceType ?? (overrides.origin === 'created' ? 'local' : 'marketplace'),
        providerKey: 'local',
        pluginKey: overrides.pluginKey,
      },
      origin: overrides.origin,
      displayName: overrides.name ?? overrides.pluginKey,
      description: '',
      version: '0.1.0',
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
        connectors: [],
      },
      interface: null,
      packageRef: null,
      sourcePayload: null,
    },
    status: { state: 'enabled', devices: [] },
  }
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.pluginKey,
    description: '',
    enabled: true,
    version: '0.1.0',
    origin: overrides.origin,
    sourceLabel: 'me',
    distribution: overrides.origin === 'created' ? 'personal' : 'public',
    updateAvailable: false,
    componentCounts: {},
    raw,
  }
}

describe('pluginOwnerLocalPackage', () => {
  test('finds packable created install by slug even when another market row is selected', () => {
    const market = installedItem({
      id: '101',
      origin: 'market',
      pluginKey: 'dev-tools',
      name: 'Dev Tools',
    })
    const created = installedItem({
      id: 'local-1',
      origin: 'created',
      pluginKey: 'Dev Tools',
      name: 'Dev Tools',
    })
    expect(isPackableCreatedPlugin(market)).toBe(false)
    expect(findPackableCreatedPlugin([market, created], ['dev-tools', 'Dev Tools'])).toEqual(
      created
    )
  })

  test('does not bind local created packages to recipient or catalog listings', () => {
    expect(
      marketplaceItemOwnsLocalCreatedPackage({
        accessRole: 'recipient',
        visibility: 'personal',
        latestReleaseId: 12,
      })
    ).toBe(false)
    expect(
      marketplaceItemOwnsLocalCreatedPackage({
        accessRole: 'catalog',
        visibility: 'personal',
        latestReleaseId: 12,
      })
    ).toBe(false)
    expect(
      marketplaceItemOwnsLocalCreatedPackage({
        accessRole: 'owner',
        visibility: 'personal',
        latestReleaseId: 12,
      })
    ).toBe(true)
    expect(
      marketplaceItemOwnsLocalCreatedPackage({
        latestReleaseId: null,
        visibility: 'personal',
      })
    ).toBe(true)
  })

  test('continue-editing prefers packable key and falls back to personal owner listing name', () => {
    const created = installedItem({
      id: 'local-1',
      origin: 'created',
      pluginKey: 'Dev Tools',
    })
    expect(
      resolveContinueEditingPluginKey({
        packableCreated: created,
        currentPlugin: null,
        ownedListingName: 'dev-tools',
        listing: { accessRole: 'owner', visibility: 'personal', latestReleaseId: 12 },
      })
    ).toBe('Dev Tools')

    expect(
      resolveContinueEditingPluginKey({
        packableCreated: null,
        currentPlugin: installedItem({
          id: '101',
          origin: 'market',
          pluginKey: 'dev-tools',
        }),
        ownedListingName: 'dev-tools',
        listing: { accessRole: 'owner', visibility: 'personal', latestReleaseId: 12 },
      })
    ).toBe('dev-tools')

    expect(
      resolveContinueEditingPluginKey({
        packableCreated: null,
        currentPlugin: installedItem({
          id: '101',
          origin: 'market',
          pluginKey: 'dev-tools',
        }),
        ownedListingName: 'dev-tools',
        listing: { accessRole: 'recipient', visibility: 'personal', latestReleaseId: 12 },
      })
    ).toBeNull()
  })

  test('matches source keys before a common display name and rejects ambiguous display names', () => {
    const a = installedItem({ id: 'a', origin: 'created', pluginKey: 'source-a', name: '助手' })
    const b = installedItem({ id: 'b', origin: 'created', pluginKey: 'source-b', name: '助手' })
    expect(findPackableCreatedPlugin([a, b], ['source-b', '助手'])).toBe(b)
    expect(findPackableCreatedPlugin([a, b], ['助手'])).toBeNull()
  })

  test('explicit recipient and catalog listings override stale local source flags', () => {
    const stale = installedItem({ id: 'stale', origin: 'created', pluginKey: 'shared' })
    for (const accessRole of ['recipient', 'catalog'] as const) {
      expect(
        resolveContinueEditingPluginKey({
          packableCreated: stale,
          currentPlugin: stale,
          listing: { accessRole, visibility: 'personal', latestReleaseId: 12 },
        })
      ).toBeNull()
    }
    stale.raw.spec.sourcePayload = { managedByWegent: true }
    expect(isPackableCreatedPlugin(stale)).toBe(false)
    expect(
      resolveContinueEditingPluginKey({ packableCreated: stale, currentPlugin: stale })
    ).toBeNull()
    expect(findPackableCreatedPlugin([stale], ['shared'])).toBeNull()
  })

  test('keeps a legacy public owners independent local source editable', () => {
    const created = installedItem({ id: 'legacy', origin: 'created', pluginKey: 'legacy-plugin' })
    const listing = {
      accessRole: 'owner' as const,
      visibility: 'public' as const,
      latestReleaseId: 12,
    }
    expect(marketplaceItemOwnsLocalCreatedPackage(listing)).toBe(true)
    expect(
      resolveContinueEditingPluginKey({ packableCreated: created, currentPlugin: created, listing })
    ).toBe('legacy-plugin')
  })
})
