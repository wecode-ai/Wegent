// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ModelEnvConfig, ModelRuntimeConfig, ModelSpecConfig } from '@/apis/models'

const FORM_MANAGED_SPEC_KEYS = new Set([
  'modelConfig',
  'protocol',
  'apiFormat',
  'modelType',
  'modelGroup',
  'modelSubGroup',
  'costIndex',
  'ttsConfig',
  'sttConfig',
  'embeddingConfig',
  'rerankConfig',
  'videoConfig',
  'imageConfig',
  'modelCapabilities',
  'isWeworkAvailable',
])

const FORM_MANAGED_MODEL_CONFIG_KEYS = new Set([
  'env',
  'context_window',
  'max_output_tokens',
  'visionSidecarModel',
  'modelCapabilities',
])

const FORM_MANAGED_MODEL_ENV_KEYS = new Set([
  'model',
  'model_id',
  'api_key',
  'base_url',
  'custom_headers',
  'thinking_config',
  'thinkingConfig',
])

const FORM_MANAGED_NESTED_SPEC_KEYS: Record<string, ReadonlySet<string>> = {
  ttsConfig: new Set(['voice', 'speed', 'output_format']),
  sttConfig: new Set(['language', 'transcription_format']),
  embeddingConfig: new Set(['dimensions', 'encoding_format', 'additional_input_modalities']),
  rerankConfig: new Set(['top_n', 'return_documents']),
  videoConfig: new Set([
    'resolution',
    'ratio',
    'duration',
    'generate_audio',
    'draft',
    'seed',
    'camera_fixed',
    'watermark',
    'capabilities',
  ]),
  imageConfig: new Set([
    'size',
    'capabilities',
    'sequential_image_generation',
    'max_images',
    'response_format',
    'output_format',
    'output_compression',
    'quality',
    'background',
    'moderation',
    'watermark',
    'optimize_prompt_mode',
    'max_reference_images',
  ]),
  modelCapabilities: new Set(['supportsImage', 'supportsVideo']),
}

const FORM_MANAGED_NESTED_OBJECT_KEYS: Record<string, ReadonlySet<string>> = {
  'videoConfig.capabilities': new Set([
    'aspect_ratios',
    'resolutions',
    'durations_sec',
    'supports_image_input',
    'supports_video_input',
    'supports_audio_input',
    'generate_audio',
    'max_reference_materials',
    'max_reference_images',
    'max_reference_images_with_video',
    'max_reference_videos',
    'max_reference_audios',
    'image_input_required',
    'reference_material_required',
    'image_formats',
    'image_max_size_mb',
    'image_min_dimension',
    'image_max_dimension',
    'image_min_aspect_ratio',
    'image_max_aspect_ratio',
    'video_formats',
    'video_max_size_mb',
    'video_min_duration_sec',
    'video_max_duration_sec',
    'video_min_dimension',
    'video_max_dimension',
    'video_min_pixels',
    'video_max_pixels',
    'video_min_aspect_ratio',
    'video_max_aspect_ratio',
    'video_min_fps',
    'video_max_fps',
    'audio_formats',
    'audio_max_size_mb',
    'audio_min_duration_sec',
    'audio_max_duration_sec',
    'generation_modes',
  ]),
  'imageConfig.capabilities': new Set([
    'supports_image_input',
    'max_reference_images',
    'image_formats',
    'image_max_size_mb',
    'image_min_dimension',
    'image_max_dimension',
    'image_min_aspect_ratio',
    'image_max_aspect_ratio',
  ]),
}

const UNSAFE_MODEL_SPEC_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export type ModelSpecValidationError =
  | 'invalid_json'
  | 'invalid_object'
  | 'invalid_model_config'
  | 'unsafe_keys'

export type ModelSpecValidationResult =
  | {
      value: ModelSpecConfig
      error: null
      paths: []
      line?: number
      column?: number
    }
  | {
      value: null
      error: ModelSpecValidationError
      paths: string[]
      line?: number
      column?: number
    }

export function isModelConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectUnsafePaths(value: unknown, path = 'spec'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectUnsafePaths(item, `${path}[${index}]`))
  }
  if (!isModelConfigObject(value)) return []

  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const keyPath = `${path}.${key}`
    return [
      ...(UNSAFE_MODEL_SPEC_KEYS.has(key) ? [keyPath] : []),
      ...collectUnsafePaths(nestedValue, keyPath),
    ]
  })
}

function jsonErrorLocation(error: unknown, value: string): { line?: number; column?: number } {
  if (!(error instanceof SyntaxError)) return {}
  const lineColumnMatch = error.message.match(/line\s+(\d+)\s+column\s+(\d+)/i)
  if (lineColumnMatch) {
    return { line: Number(lineColumnMatch[1]), column: Number(lineColumnMatch[2]) }
  }
  const positionMatch = error.message.match(/position\s+(\d+)/i)
  if (!positionMatch) return {}
  const prefix = value.slice(0, Number(positionMatch[1]))
  const lines = prefix.split('\n')
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

export function validateModelSpecJson(value: string): ModelSpecValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    return { value: null, error: 'invalid_json', paths: [], ...jsonErrorLocation(error, value) }
  }

  if (!isModelConfigObject(parsed)) {
    return { value: null, error: 'invalid_object', paths: [] }
  }
  if (!isModelConfigObject(parsed.modelConfig)) {
    return { value: null, error: 'invalid_model_config', paths: [] }
  }

  const unsafePaths = collectUnsafePaths(parsed)
  if (unsafePaths.length > 0) {
    return { value: null, error: 'unsafe_keys', paths: unsafePaths }
  }

  return { value: parsed as ModelSpecConfig, error: null, paths: [] }
}

export function formatModelSpec(spec: ModelSpecConfig): string {
  return JSON.stringify(spec, null, 2)
}

export function canEditModelSpecWithForm(spec: ModelSpecConfig): boolean {
  return isModelConfigObject(spec.modelConfig) && isModelConfigObject(spec.modelConfig.env)
}

function withoutKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)))
}

export function extractUnmanagedModelEnv(
  spec: ModelSpecConfig | null | undefined
): Record<string, unknown> {
  const modelConfig: Record<string, unknown> = isModelConfigObject(spec?.modelConfig)
    ? spec.modelConfig
    : {}
  const env = isModelConfigObject(modelConfig.env) ? modelConfig.env : {}
  return withoutKeys(env, FORM_MANAGED_MODEL_ENV_KEYS)
}

export function mergeFormManagedSpec(
  originalSpec: ModelSpecConfig | null | undefined,
  managedSpec: ModelSpecConfig
): ModelSpecConfig {
  const original: Record<string, unknown> = isModelConfigObject(originalSpec) ? originalSpec : {}
  const originalModelConfig: Record<string, unknown> = isModelConfigObject(original.modelConfig)
    ? original.modelConfig
    : {}
  const originalEnv = isModelConfigObject(originalModelConfig.env) ? originalModelConfig.env : {}
  const managedModelConfig = managedSpec.modelConfig

  const mergedSpec = {
    ...withoutKeys(original, FORM_MANAGED_SPEC_KEYS),
    ...managedSpec,
    modelConfig: {
      ...withoutKeys(originalModelConfig, FORM_MANAGED_MODEL_CONFIG_KEYS),
      ...managedModelConfig,
      env: {
        ...withoutKeys(originalEnv, FORM_MANAGED_MODEL_ENV_KEYS),
        ...managedModelConfig.env,
      } as ModelEnvConfig,
    } as ModelRuntimeConfig,
  } as ModelSpecConfig

  for (const [key, managedKeys] of Object.entries(FORM_MANAGED_NESTED_SPEC_KEYS)) {
    const originalNested = isModelConfigObject(original[key]) ? original[key] : {}
    const managedNested = isModelConfigObject(managedSpec[key]) ? managedSpec[key] : null
    const mergedNested = {
      ...withoutKeys(originalNested, managedKeys),
      ...(managedNested || {}),
    }

    for (const [path, nestedManagedKeys] of Object.entries(FORM_MANAGED_NESTED_OBJECT_KEYS)) {
      const [parentKey, nestedKey] = path.split('.')
      if (parentKey !== key) continue

      const originalNestedObject = isModelConfigObject(originalNested[nestedKey])
        ? originalNested[nestedKey]
        : {}
      const managedNestedObject =
        managedNested && isModelConfigObject(managedNested[nestedKey])
          ? managedNested[nestedKey]
          : null
      const mergedNestedObject = {
        ...withoutKeys(originalNestedObject, nestedManagedKeys),
        ...(managedNestedObject || {}),
      }
      if (Object.keys(mergedNestedObject).length > 0) {
        mergedNested[nestedKey] = mergedNestedObject
      } else {
        delete mergedNested[nestedKey]
      }
    }

    if (Object.keys(mergedNested).length > 0) {
      mergedSpec[key] = mergedNested
    } else {
      delete mergedSpec[key]
    }
  }

  return mergedSpec
}

export function extractThinkingConfig(
  env: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  const config = env?.thinking_config ?? env?.thinkingConfig
  if (!isModelConfigObject(config)) return undefined

  const keys = Object.keys(config)
  const nestedKey = keys[0]
  const nestedConfig = nestedKey ? config[nestedKey] : undefined
  if (
    keys.length === 1 &&
    (nestedKey === 'thinking_config' || nestedKey === 'thinkingConfig') &&
    isModelConfigObject(nestedConfig)
  ) {
    return nestedConfig
  }

  return config
}
