// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { EmbeddingConfig } from '@/apis/models'

export function normalizeAdditionalInputModalities(modalities?: string[]): string[] {
  if (!modalities || modalities.length === 0) {
    return []
  }

  const normalized = modalities
    .map(modality => modality.trim().toLowerCase())
    .filter(modality => modality === 'image')

  return Array.from(new Set(normalized))
}

export function hasImageInputCapability(config?: EmbeddingConfig): boolean {
  return normalizeAdditionalInputModalities(config?.additional_input_modalities).includes('image')
}

export function buildEmbeddingConfig({
  dimensions,
  encodingFormat,
  supportsImageInput,
}: {
  dimensions?: number
  encodingFormat: 'float' | 'base64'
  supportsImageInput: boolean
}): EmbeddingConfig {
  return {
    dimensions,
    encoding_format: encodingFormat,
    additional_input_modalities: supportsImageInput ? ['image'] : [],
  }
}
