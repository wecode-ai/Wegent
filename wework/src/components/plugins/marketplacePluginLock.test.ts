import { describe, expect, test } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import { marketplacePluginLockLabel, resolveMarketplacePluginLock } from './marketplacePluginLock'

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

function item(overrides: Partial<PluginMarketplaceItem> = {}): PluginMarketplaceItem {
  return {
    id: 'gmail@openai-curated-remote',
    remotePluginId: 'plugin_connector_1p_95d39881713c8191931482a62d6edff9',
    name: 'gmail',
    displayName: 'Gmail',
    description: '',
    visibility: 'public',
    featured: true,
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

const t = (_key: string, defaultValue: string) => defaultValue

describe('resolveMarketplacePluginLock', () => {
  test('locks plan-ineligible admin-disabled plugins', () => {
    expect(
      resolveMarketplacePluginLock(
        item({
          manifest: {
            availability: 'DISABLED_BY_ADMIN',
            disabledReason: 'plan_not_eligible',
          },
        })
      )
    ).toEqual({ kind: 'plan_not_eligible' })
    expect(marketplacePluginLockLabel({ kind: 'plan_not_eligible' }, t)).toBe('你的套餐不支持')
  })

  test('locks generic admin-disabled plugins', () => {
    expect(
      resolveMarketplacePluginLock(
        item({
          manifest: {
            availability: 'DISABLED_BY_ADMIN',
          },
        })
      )
    ).toEqual({ kind: 'disabled_by_admin' })
  })

  test('locks not-available install policy', () => {
    expect(
      resolveMarketplacePluginLock(
        item({
          manifest: {
            installPolicy: 'NOT_AVAILABLE',
          },
        })
      )
    ).toEqual({ kind: 'not_available' })
  })

  test('does not lock installed or available plugins', () => {
    expect(
      resolveMarketplacePluginLock(
        item({
          installed: true,
          manifest: { availability: 'DISABLED_BY_ADMIN' },
        })
      )
    ).toBeNull()
    expect(
      resolveMarketplacePluginLock(
        item({
          manifest: { availability: 'AVAILABLE' },
        })
      )
    ).toBeNull()
  })
})
