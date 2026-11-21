// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  buildModelCascadeGroups,
  matchesModelSearch,
} from '@/components/model-select/model-grouping'
import type { GroupableModel } from '@/components/model-select/model-grouping'

const models: GroupableModel[] = [
  {
    name: 'model-a',
    displayName: 'Model A',
    provider: 'provider-one',
    modelId: 'model-a-id',
    capability: 'Fast reasoning for complex tasks',
    modelGroup: 'Primary One',
    modelSubGroup: 'Secondary One',
  },
  {
    name: 'model-b',
    displayName: 'Model B',
    provider: 'provider-two',
    modelId: 'model-b-id',
    modelGroup: 'Primary One',
    modelSubGroup: 'Secondary Two',
  },
  {
    name: 'model-c',
    displayName: 'Model C',
    provider: 'provider-three',
    modelId: 'model-c-id',
  },
]

describe('model grouping', () => {
  it('builds two-level groups from model spec grouping fields', () => {
    const groups = buildModelCascadeGroups(models, {
      ungroupedLabel: 'Ungrouped',
      uncategorizedLabel: 'Other',
    })

    expect(groups).toEqual([
      {
        configuredName: 'Primary One',
        name: 'Primary One',
        count: 2,
        subGroups: [
          { name: 'Secondary One', count: 1, models: [models[0]] },
          { name: 'Secondary Two', count: 1, models: [models[1]] },
        ],
      },
      {
        configuredName: null,
        name: 'Ungrouped',
        count: 1,
        subGroups: [{ name: 'Other', count: 1, models: [models[2]] }],
      },
    ])
  })

  it('keeps an explicitly named group separate from the ungrouped models', () => {
    const named = { ...models[0], modelGroup: 'Ungrouped' }
    const groups = buildModelCascadeGroups([models[2], named], {
      ungroupedLabel: 'Ungrouped',
      uncategorizedLabel: 'Other',
    })
    expect(groups.map(group => [group.configuredName, group.subGroups[0].models[0]])).toEqual([
      ['Ungrouped', named],
      [null, models[2]],
    ])
  })

  it('matches search against model group and subgroup text', () => {
    expect(matchesModelSearch(models[0], 'primary one')).toBe(true)
    expect(matchesModelSearch(models[0], 'secondary one')).toBe(true)
    expect(matchesModelSearch(models[0], 'provider-one')).toBe(true)
    expect(matchesModelSearch(models[0], 'reasoning')).toBe(true)
    expect(matchesModelSearch(models[0], 'missing')).toBe(false)
  })
})
