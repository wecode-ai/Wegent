// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ModelCapabilities } from '@/apis/models'

export interface ModelCapabilitySource {
  modelCapabilities?: unknown
  config?: Record<string, unknown> | null
}

export interface ModelCapabilitySpecSource {
  modelCapabilities?: unknown
  modelConfig?: Record<string, unknown> | null
}

function normalizeModelCapabilities(value: unknown): ModelCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const candidate = value as Record<string, unknown>
  const capabilities: ModelCapabilities = {}
  if (typeof candidate.supportsImage === 'boolean') {
    capabilities.supportsImage = candidate.supportsImage
  }
  if (typeof candidate.supportsVideo === 'boolean') {
    capabilities.supportsVideo = candidate.supportsVideo
  }
  return capabilities
}

export function getModelCapabilities(model: ModelCapabilitySource): ModelCapabilities {
  const capabilities = normalizeModelCapabilities(model.modelCapabilities)
  if (capabilities) return capabilities

  return normalizeModelCapabilities(model.config?.modelCapabilities) ?? {}
}

export function getModelCapabilitiesFromSpec(spec: ModelCapabilitySpecSource): ModelCapabilities {
  return getModelCapabilities({
    modelCapabilities: spec.modelCapabilities,
    config: spec.modelConfig,
  })
}
