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
        name: 'Primary One',
        count: 2,
        subGroups: [
          { name: 'Secondary One', count: 1, models: [models[0]] },
          { name: 'Secondary Two', count: 1, models: [models[1]] },
        ],
      },
      {
        name: 'Ungrouped',
        count: 1,
        subGroups: [{ name: 'Other', count: 1, models: [models[2]] }],
      },
    ])
  })

  it('matches search against model group and subgroup text', () => {
    expect(matchesModelSearch(models[0], 'primary one')).toBe(true)
    expect(matchesModelSearch(models[0], 'secondary one')).toBe(true)
    expect(matchesModelSearch(models[0], 'provider-one')).toBe(true)
    expect(matchesModelSearch(models[0], 'missing')).toBe(false)
  })
})
