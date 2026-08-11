import { describe, expect, test } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import {
  marketplaceSearchScore,
  normalizeMarketplaceSearchQuery,
  rankMarketplaceSearchResults,
} from './marketplaceSearch'

function marketplaceItem(
  overrides: Partial<PluginMarketplaceItem> & Pick<PluginMarketplaceItem, 'id' | 'name'>
): PluginMarketplaceItem {
  return {
    remotePluginId: String(overrides.id),
    displayName: overrides.displayName ?? overrides.name,
    description: '',
    featured: false,
    installed: false,
    enabled: false,
    sourceType: 'marketplace',
    visibility: 'public',
    ownerUserId: 0,
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
    manifest: {},
    ...overrides,
  }
}

describe('marketplaceSearch', () => {
  test('normalizeMarketplaceSearchQuery trims and lowercases', () => {
    expect(normalizeMarketplaceSearchQuery('  GitHub  ')).toBe('github')
  })

  test('rankMarketplaceSearchResults prefers exact name matches', () => {
    const items = [
      marketplaceItem({ id: 1, name: 'tools', displayName: 'GitHub Tools' }),
      marketplaceItem({ id: 2, name: 'github', displayName: 'GitHub' }),
      marketplaceItem({ id: 3, name: 'slack', displayName: 'Slack' }),
    ]

    expect(rankMarketplaceSearchResults(items, 'github').map(item => item.id)).toEqual([2, 1])
  })

  test('marketplaceSearchScore returns null when nothing matches', () => {
    expect(
      marketplaceSearchScore(
        marketplaceItem({ id: 1, name: 'slack', displayName: 'Slack' }),
        'github'
      )
    ).toBeNull()
  })

  test('marketplaceSearchScore matches description and interface blurbs', () => {
    expect(
      marketplaceSearchScore(
        marketplaceItem({
          id: 1,
          name: 'office',
          displayName: 'Office Kit',
          description: 'Manage DingTalk documents and calendars',
        }),
        'dingtalk'
      )
    ).toBe(100)

    expect(
      marketplaceSearchScore(
        marketplaceItem({
          id: 2,
          name: 'notes',
          displayName: 'Notes',
          interface: { shortDescription: 'Capture meeting notes in Feishu' },
        }),
        'feishu'
      )
    ).toBe(100)
  })

  test('rankMarketplaceSearchResults returns all items for empty query', () => {
    const items = [marketplaceItem({ id: 1, name: 'a' }), marketplaceItem({ id: 2, name: 'b' })]
    expect(rankMarketplaceSearchResults(items, '  ')).toEqual(items)
  })
})
