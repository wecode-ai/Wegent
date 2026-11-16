// @vitest-environment node

import type { PluginMarketplaceItem } from '@/types/api'
import { describe, expect, test } from 'vitest'
import { groupMarketplaceItemsAdaptively } from './marketplaceCategorySections'

const components = {
  skills: [],
  commands: [],
  agents: [],
  hooks: [],
  mcps: [],
  lsps: [],
  monitors: [],
  bins: [],
}

function item(overrides: Partial<PluginMarketplaceItem>): PluginMarketplaceItem {
  return {
    id: overrides.id ?? overrides.name ?? 'plugin',
    remotePluginId: String(overrides.id ?? overrides.name ?? 'plugin'),
    name: 'plugin',
    displayName: 'Plugin',
    description: '',
    visibility: 'public',
    featured: false,
    installed: false,
    installedPluginId: null,
    enabled: false,
    sourceType: 'marketplace',
    components,
    manifest: {},
    ownerUserId: 0,
    ...overrides,
  }
}

const labels = {
  featured: 'Featured',
  other: 'Other',
  all: 'All plugins',
}

describe('groupMarketplaceItemsAdaptively', () => {
  test('keeps categories for large catalogs and flattens search results', () => {
    const items = Array.from({ length: 17 }, (_, index) =>
      item({
        id: `plugin-${index}`,
        name: `plugin-${index}`,
        interface: { category: index % 2 === 0 ? 'Design' : 'Productivity' },
      })
    )

    expect(groupMarketplaceItemsAdaptively(items, labels).map(section => section.title)).toEqual([
      'Design',
      'Productivity',
    ])
    expect(groupMarketplaceItemsAdaptively(items, labels, { forceFlat: true })[0]).toMatchObject({
      key: 'all',
      items,
      flat: true,
    })
  })
})
