import { describe, expect, test } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import {
  findPackableCreatedPlugin,
  isPackableCreatedPlugin,
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
        isPersonalOwner: true,
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
        isPersonalOwner: true,
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
        isPersonalOwner: false,
      })
    ).toBeNull()
  })
})
