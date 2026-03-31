// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  buildEmbeddingConfig,
  hasImageInputCapability,
  normalizeAdditionalInputModalities,
} from '@/features/settings/utils/embedding-model-config'

describe('embedding-model-config', () => {
  test('normalizes missing modalities to an empty list', () => {
    expect(normalizeAdditionalInputModalities(undefined)).toEqual([])
  })

  test('keeps the image modality and removes duplicates', () => {
    expect(normalizeAdditionalInputModalities(['image', 'IMAGE', 'image'])).toEqual(['image'])
  })

  test('builds embedding config without extra modalities by default', () => {
    expect(
      buildEmbeddingConfig({
        dimensions: 1536,
        encodingFormat: 'float',
        supportsImageInput: false,
      })
    ).toEqual({
      dimensions: 1536,
      encoding_format: 'float',
      additional_input_modalities: [],
    })
  })

  test('builds embedding config with image capability when enabled', () => {
    expect(
      buildEmbeddingConfig({
        dimensions: 1536,
        encodingFormat: 'float',
        supportsImageInput: true,
      })
    ).toEqual({
      dimensions: 1536,
      encoding_format: 'float',
      additional_input_modalities: ['image'],
    })
  })

  test('detects image capability from embedding config', () => {
    expect(
      hasImageInputCapability({
        dimensions: 1536,
        encoding_format: 'float',
        additional_input_modalities: ['image'],
      })
    ).toBe(true)
    expect(
      hasImageInputCapability({
        dimensions: 1536,
        encoding_format: 'float',
      })
    ).toBe(false)
  })
})
