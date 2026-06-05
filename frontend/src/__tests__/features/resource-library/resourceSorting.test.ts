// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getResourceLibrarySortMode,
  sortResourceLibraryItems,
  type ResourceLibrarySortSource,
} from '@/features/resource-library/resourceSorting'

interface TestResource {
  id: number
  name: string
  displayName?: string
  namespace?: string
  source: ResourceLibrarySortSource
  created_at?: string
  updated_at?: string
}

const groupDisplayNames = new Map([
  ['team-a', 'Alpha Team'],
  ['team-z', 'Zeta Team'],
])

function sortResources(items: TestResource[], sortMode: 'default' | 'latest') {
  return sortResourceLibraryItems(items, {
    sortMode,
    groupDisplayNames,
    getSource: item => item.source,
    getName: item => item.name,
    getDisplayName: item => item.displayName,
    getNamespace: item => item.namespace,
    getCreatedAt: item => item.created_at,
    getUpdatedAt: item => item.updated_at,
    getStableId: item => item.id,
  })
}

describe('resource library sorting', () => {
  it('normalizes invalid sort modes to the default mode', () => {
    expect(getResourceLibrarySortMode(null)).toBe('default')
    expect(getResourceLibrarySortMode('latest')).toBe('latest')
    expect(getResourceLibrarySortMode('created')).toBe('default')
  })

  it('sorts default mode by source group, team name, then resource display name', () => {
    const sorted = sortResources(
      [
        { id: 1, name: 'system-alpha', displayName: 'Alpha', source: 'system' },
        {
          id: 2,
          name: 'group-z-beta',
          displayName: 'Beta',
          namespace: 'team-z',
          source: 'group',
        },
        { id: 3, name: 'personal-zeta', displayName: 'Zeta', source: 'personal' },
        {
          id: 4,
          name: 'group-a-zoo',
          displayName: 'Zoo',
          namespace: 'team-a',
          source: 'group',
        },
        {
          id: 5,
          name: 'group-a-alpha',
          displayName: 'Alpha',
          namespace: 'team-a',
          source: 'group',
        },
        { id: 6, name: 'personal-alpha', displayName: 'Alpha', source: 'personal' },
      ],
      'default'
    )

    expect(sorted.map(item => item.name)).toEqual([
      'personal-alpha',
      'personal-zeta',
      'group-a-alpha',
      'group-a-zoo',
      'group-z-beta',
      'system-alpha',
    ])
  })

  it('sorts latest mode by updated time and falls back to default ordering for ties', () => {
    const sorted = sortResources(
      [
        {
          id: 1,
          name: 'system-old',
          displayName: 'Old',
          source: 'system',
          updated_at: '2026-05-01T00:00:00Z',
        },
        {
          id: 2,
          name: 'personal-mid',
          displayName: 'Mid',
          source: 'personal',
          updated_at: '2026-05-02T00:00:00Z',
        },
        {
          id: 3,
          name: 'group-new',
          displayName: 'New',
          namespace: 'team-a',
          source: 'group',
          updated_at: '2026-05-03T00:00:00Z',
        },
        {
          id: 4,
          name: 'personal-alpha-tie',
          displayName: 'Alpha',
          source: 'personal',
          updated_at: '2026-05-03T00:00:00Z',
        },
      ],
      'latest'
    )

    expect(sorted.map(item => item.name)).toEqual([
      'personal-alpha-tie',
      'group-new',
      'personal-mid',
      'system-old',
    ])
  })
})
