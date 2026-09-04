// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getPublicModelVisibilityFromConfig,
  parsePublicModelConfig,
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

    expect(parsePublicModelConfig(invalidJson)).toBeNull()
    expect(getPublicModelVisibilityFromConfig(invalidJson)).toBeUndefined()
    expect(setPublicModelVisibilityInConfig(invalidJson, false)).toBe(invalidJson)
  })

  test.each(['null', '"invalid"', '[]', '42'])(
    'rejects a non-object spec without replacing it: %s',
    spec => {
      const config = JSON.stringify({ kind: 'Model', spec: JSON.parse(spec) })

      expect(parsePublicModelConfig(config)).toBeNull()
      expect(setPublicModelVisibilityInConfig(config, false)).toBe(config)
    }
  )
})
