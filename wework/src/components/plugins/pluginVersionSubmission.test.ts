import { describe, expect, test } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
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
  test.each([
    ['1.10.0', true],
    ['1.9.0', false],
    ['1.9.0+build.2', false],
    ['1.8.0', false],
    ['1.9.0-beta.1', false],
    ['invalid', false],
  ])('compares %s against the shared SemVer', (version, expected) => {
    expect(hasNewPersonalPluginVersion(source(version), listing)).toBe(expected)
  })

  test('uses the cloud version preserved beneath the editable card version', () => {
    expect(
      hasNewPersonalPluginVersion(source('2.0.0'), {
        ...listing,
        version: '2.0.0',
        sharedVersion: '1.9.0',
      })
    ).toBe(true)
  })

  test.each(['GitLab Engineering', 'gitlab-engineering'])(
    'matches source key %s to the published manifest name',
    pluginKey => {
      expect(
        hasNewPersonalPluginVersion(source('2.0.0', pluginKey), {
          ...listing,
          name: 'GitLab Engineering',
        })
      ).toBe(true)
    }
  )

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

  test('requires the personal owner, an existing release and packable local source', () => {
    expect(hasNewPersonalPluginVersion(source('2.0.0'), { ...listing, name: 'other-source' })).toBe(
      false
    )
    for (const accessRole of ['recipient', 'catalog'] as const) {
      expect(hasNewPersonalPluginVersion(source('2.0.0'), { ...listing, accessRole })).toBe(false)
    }
    expect(
      hasNewPersonalPluginVersion(source('2.0.0'), { ...listing, visibility: 'workspace' })
    ).toBe(false)
    expect(
      hasNewPersonalPluginVersion(source('2.0.0'), { ...listing, latestReleaseId: null })
    ).toBe(false)
    expect(hasNewPersonalPluginVersion(null, listing)).toBe(false)
    expect(hasNewPersonalPluginVersion(source('2.0.0'), null)).toBe(false)
    expect(
      hasNewPersonalPluginVersion(
        {
          ...source('2.0.0'),
          origin: 'market',
          raw: { spec: { source: { type: 'marketplace' } } },
        } as InstalledPluginItem,
        listing
      )
    ).toBe(false)
  })
})
