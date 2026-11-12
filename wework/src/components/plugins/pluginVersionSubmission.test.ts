// @vitest-environment node

import type { PluginMarketplaceItem } from '@/types/api'
import { describe, expect, test } from 'vitest'
import type { InstalledPluginItem } from './PluginManagementRows'
import { hasNewPersonalPluginVersion } from './pluginVersionSubmission'

const source = (version: string, pluginKey = 'dev-tools') =>
  ({
    version,
    origin: 'created',
    raw: { spec: { source: { type: 'local', pluginKey } } },
  }) as InstalledPluginItem
const listing = {
  name: 'dev-tools',
  accessRole: 'owner',
  visibility: 'personal',
  version: '1.9.0',
  latestReleaseId: 7,
} as PluginMarketplaceItem

describe('hasNewPersonalPluginVersion', () => {
  test('keeps normalized identity matching scoped to the owner and matching source', () => {
    const namedListing = { ...listing, name: 'GitLab Engineering' }
    expect(hasNewPersonalPluginVersion(source('2.0.0', 'other-source'), namedListing)).toBe(false)
    for (const accessRole of ['recipient', 'catalog'] as const) {
      expect(
        hasNewPersonalPluginVersion(source('2.0.0', 'GitLab Engineering'), {
          ...namedListing,
          accessRole,
        })
      ).toBe(false)
    }
  })
})
