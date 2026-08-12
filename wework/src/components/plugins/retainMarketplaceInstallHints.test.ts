import { describe, expect, test } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import { retainMarketplaceInstallHints } from './retainMarketplaceInstallHints'

function item(overrides: Partial<PluginMarketplaceItem> = {}): PluginMarketplaceItem {
  return {
    id: 'github@openai-curated-remote',
    name: 'github',
    displayName: 'GitHub',
    description: '',
    version: '0.1.8',
    author: 'OpenAI',
    installed: false,
    installedLocally: false,
    installedPluginId: null,
    enabled: false,
    updateAvailable: false,
    latestReleaseId: null,
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
    manifest: { marketplaceId: 'openai-curated-remote' },
    interface: null,
    ...overrides,
  }
}

describe('retainMarketplaceInstallHints', () => {
  test('keeps an optimistic install when the next catalog snapshot lags', () => {
    const previous = [
      item({
        installed: true,
        installedLocally: true,
        installedPluginId: 'github@openai-curated-remote',
        enabled: true,
      }),
    ]
    const next = [item({ description: 'fresh description' })]

    expect(retainMarketplaceInstallHints(previous, next)).toEqual([
      expect.objectContaining({
        id: 'github@openai-curated-remote',
        description: 'fresh description',
        installed: true,
        installedLocally: true,
        installedPluginId: 'github@openai-curated-remote',
        enabled: true,
      }),
    ])
  })

  test('does not revive an install after the row was cleared', () => {
    const previous = [item({ installed: false, installedPluginId: null })]
    const next = [item({ installed: false, installedPluginId: null })]
    expect(retainMarketplaceInstallHints(previous, next)).toEqual(next)
  })
})
