// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  fromImageGenerationConfig,
  getDefaultImageConfig,
  toImageGenerationConfig,
} from '@/features/settings/components/model-config/ImageConfigSection'

describe('ImageConfigSection config conversion', () => {
  it('provides GPT Image-compatible defaults', () => {
    expect(getDefaultImageConfig()).toMatchObject({
      imageOutputFormat: 'png',
      imageQuality: 'auto',
      imageBackground: 'auto',
      imageModeration: 'auto',
      imageReferenceFormats: '',
    })
  })

  it('round-trips GPT Image output options', () => {
    const apiConfig = toImageGenerationConfig({
      ...getDefaultImageConfig(),
      imageOutputFormat: 'webp',
      imageOutputCompression: 80,
      imageQuality: 'high',
      imageBackground: 'opaque',
      imageModeration: 'low',
    })

    expect(apiConfig).toMatchObject({
      output_format: 'webp',
      output_compression: 80,
      quality: 'high',
      background: 'opaque',
      moderation: 'low',
    })
    expect(fromImageGenerationConfig(apiConfig)).toMatchObject({
      imageOutputFormat: 'webp',
      imageOutputCompression: 80,
      imageQuality: 'high',
      imageBackground: 'opaque',
      imageModeration: 'low',
    })
  })

  it('preserves a 16-image reference limit', () => {
    const apiConfig = toImageGenerationConfig({
      ...getDefaultImageConfig(),
      imageMaxReferenceImages: 16,
    })

    expect(apiConfig.max_reference_images).toBe(16)
    expect(fromImageGenerationConfig(apiConfig).imageMaxReferenceImages).toBe(16)
  })

  it('round-trips model-specific reference image formats', () => {
    const apiConfig = toImageGenerationConfig({
      ...getDefaultImageConfig(),
      imageReferenceFormats: 'png, webp',
    })

    expect(apiConfig.capabilities?.image_formats).toEqual(['png', 'webp'])
    expect(fromImageGenerationConfig(apiConfig).imageReferenceFormats).toBe('png, webp')
  })

  it('does not add a format restriction when the model has none', () => {
    const apiConfig = toImageGenerationConfig(getDefaultImageConfig())

    expect(apiConfig.capabilities?.image_formats).toBeUndefined()
  })
})
