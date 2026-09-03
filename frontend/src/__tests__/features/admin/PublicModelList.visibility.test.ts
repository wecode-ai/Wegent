// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getPublicModelVisibilityFromConfig,
  setPublicModelVisibilityInConfig,
} from '@/features/admin/components/PublicModelList'

describe('PublicModelList visibility config synchronization', () => {
  test('reads spec.isVisible from valid JSON', () => {
    expect(
      getPublicModelVisibilityFromConfig(
        JSON.stringify({
          kind: 'Model',
          spec: { isVisible: false },
        })
      )
    ).toBe(false)
  })

  test('writes the switch value into spec.isVisible', () => {
    const updated = setPublicModelVisibilityInConfig(
      JSON.stringify({
        kind: 'Model',
        spec: { modelType: 'llm', isVisible: true },
      }),
      false
    )

    expect(JSON.parse(updated)).toEqual({
      kind: 'Model',
      spec: { modelType: 'llm', isVisible: false },
    })
  })

  test('leaves invalid JSON unchanged while editing', () => {
    const invalidJson = '{"spec":'

    expect(getPublicModelVisibilityFromConfig(invalidJson)).toBeUndefined()
    expect(setPublicModelVisibilityInConfig(invalidJson, false)).toBe(invalidJson)
  })
})
