import { describe, expect, test } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import {
  groupMarketplaceItemsByCategory,
  previewMarketplaceSectionItems,
  prioritizeFeaturedMarketplaceItems,
} from './marketplaceCategorySections'

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

describe('groupMarketplaceItemsByCategory', () => {
  test('falls back to a single all section when nothing is featured or categorized', () => {
    const items = [item({ id: 'a', name: 'a', displayName: 'A' })]
    expect(groupMarketplaceItemsByCategory(items, labels)).toEqual([
      { key: 'all', title: 'All plugins', items },
    ])
  })

  test('puts featured first and keeps category first-seen order', () => {
    const items = [
      item({
        id: 'notion',
        name: 'notion',
        displayName: 'Notion',
        interface: { category: 'Productivity' },
      }),
      item({
        id: 'gmail',
        name: 'gmail',
        displayName: 'Gmail',
        featured: true,
        interface: { category: 'Communication' },
      }),
      item({
        id: 'slack',
        name: 'slack',
        displayName: 'Slack',
        interface: { category: 'Communication' },
      }),
      item({
        id: 'linear',
        name: 'linear',
        displayName: 'Linear',
        interface: { category: 'Productivity' },
      }),
      item({ id: 'custom', name: 'custom', displayName: 'Custom' }),
    ]

    expect(groupMarketplaceItemsByCategory(items, labels)).toEqual([
      {
        key: 'featured',
        title: 'Featured',
        items: [expect.objectContaining({ id: 'gmail' })],
      },
      {
        key: 'category-productivity',
        title: 'Productivity',
        items: [
          expect.objectContaining({ id: 'notion' }),
          expect.objectContaining({ id: 'linear' }),
        ],
      },
      {
        key: 'category-communication',
        title: 'Communication',
        items: [expect.objectContaining({ id: 'slack' })],
      },
      {
        key: 'other',
        title: 'Other',
        items: [expect.objectContaining({ id: 'custom' })],
      },
    ])
  })

  test('groups categorized items without depending on a prior display truncation', () => {
    const items = [
      item({
        id: 'gmail',
        name: 'gmail',
        featured: true,
        interface: { category: 'Communication' },
      }),
      item({
        id: 'notion',
        name: 'notion',
        interface: { category: 'Productivity' },
      }),
      item({
        id: 'linear',
        name: 'linear',
        interface: { category: 'Productivity' },
      }),
    ]
    expect(groupMarketplaceItemsByCategory(items, labels).map(section => section.key)).toEqual([
      'featured',
      'category-productivity',
    ])
  })

  test('previews a fixed number of section items for the home page', () => {
    const items = [
      item({ id: 'a', name: 'a', displayName: 'A' }),
      item({ id: 'b', name: 'b', displayName: 'B' }),
      item({ id: 'c', name: 'c', displayName: 'C' }),
      item({ id: 'd', name: 'd', displayName: 'D' }),
      item({ id: 'e', name: 'e', displayName: 'E' }),
    ]
    expect(previewMarketplaceSectionItems(items, 4)).toEqual({
      preview: items.slice(0, 4),
      rest: items.slice(4),
    })
    expect(previewMarketplaceSectionItems(items, 0)).toEqual({
      preview: [],
      rest: items,
    })
  })

  test('moves featured plugins ahead of the ranked list before truncation', () => {
    const items = [
      item({ id: 'notion', name: 'notion', interface: { category: 'Productivity' } }),
      item({
        id: 'gmail',
        name: 'gmail',
        featured: true,
        interface: { category: 'Communication' },
      }),
    ]
    expect(prioritizeFeaturedMarketplaceItems(items).map(entry => entry.id)).toEqual([
      'gmail',
      'notion',
    ])
  })

  test('keeps unique section keys for Chinese category names', () => {
    const items = [
      item({
        id: 'sites',
        name: 'sites',
        displayName: '快速建站',
        interface: { category: '效率工具' },
      }),
      item({
        id: 'wiki',
        name: 'wiki',
        displayName: 'WIKI',
        interface: { category: '开发工具' },
      }),
    ]
    const sections = groupMarketplaceItemsByCategory(items, labels)
    expect(sections.map(section => section.title)).toEqual(['效率工具', '开发工具'])
    expect(sections.map(section => section.key)).toEqual([
      `category-${encodeURIComponent('效率工具')}`,
      `category-${encodeURIComponent('开发工具')}`,
    ])
    expect(new Set(sections.map(section => section.key)).size).toBe(2)
  })
})
