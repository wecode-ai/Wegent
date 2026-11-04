// @vitest-environment node

import type { PluginMarketplaceItem } from '@/types/api'
import { describe, expect, test } from 'vitest'
import { marketplaceSearchScore } from './marketplaceSearch'

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
})
