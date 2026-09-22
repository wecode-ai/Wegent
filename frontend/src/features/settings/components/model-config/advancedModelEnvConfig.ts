// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const FORM_MANAGED_MODEL_ENV_KEYS = new Set([
  'model',
  'model_id',
  'api_key',
  'base_url',
  'custom_headers',
  'thinking_config',
  'thinkingConfig',
])

const UNSAFE_MODEL_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export type AdvancedModelEnvValidationError =
  | 'invalid_json'
  | 'invalid_object'
  | 'reserved_keys'
  | 'unsafe_keys'

export type AdvancedModelEnvValidationResult =
  | {
      value: Record<string, unknown>
      error: null
      keys: []
    }
  | {
      value: null
      error: AdvancedModelEnvValidationError
      keys: string[]
    }

export function extractAdvancedModelEnv(
  env: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!env) return {}

  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !FORM_MANAGED_MODEL_ENV_KEYS.has(key))
  )
}

export function formatAdvancedModelEnv(value: Record<string, unknown> | undefined): string {
  if (!value || Object.keys(value).length === 0) return ''
  return JSON.stringify(value, null, 2)
}

export function validateAdvancedModelEnv(value: string): AdvancedModelEnvValidationResult {
  if (!value.trim()) {
    return { value: {}, error: null, keys: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { value: null, error: 'invalid_json', keys: [] }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { value: null, error: 'invalid_object', keys: [] }
  }

  const keys = Object.keys(parsed)
  const reservedKeys = keys.filter(key => FORM_MANAGED_MODEL_ENV_KEYS.has(key))
  if (reservedKeys.length > 0) {
    return { value: null, error: 'reserved_keys', keys: reservedKeys }
  }

  const unsafeKeys = keys.filter(key => UNSAFE_MODEL_ENV_KEYS.has(key))
  if (unsafeKeys.length > 0) {
    return { value: null, error: 'unsafe_keys', keys: unsafeKeys }
  }

  return {
    value: parsed as Record<string, unknown>,
    error: null,
    keys: [],
  }
}

export function countAdvancedModelEnvFields(value: string): number {
  const result = validateAdvancedModelEnv(value)
  return result.value ? Object.keys(result.value).length : 0
}
