// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parsePublicModelConfig = (value: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isJsonObject(parsed)) {
      return null
    }
    if ('spec' in parsed && !isJsonObject(parsed.spec)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export const getPublicModelSpec = (config: Record<string, unknown>): Record<string, unknown> =>
  isJsonObject(config.spec) ? { ...config.spec } : {}

export const getPublicModelSpecValue = (
  json: Record<string, unknown>,
  key: 'modelGroup' | 'modelSubGroup'
): string => {
  const spec = json.spec
  if (typeof spec === 'object' && spec !== null && !Array.isArray(spec)) {
    const value = (spec as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : ''
  }
  return ''
}

export const getPublicModelSpecBoolean = (json: Record<string, unknown>, key: string): boolean => {
  const spec = json.spec
  if (typeof spec === 'object' && spec !== null && !Array.isArray(spec)) {
    const value = (spec as Record<string, unknown>)[key]
    return typeof value === 'boolean' ? value : false
  }
  return false
}

export const getPublicModelVisibilityFromConfig = (value: string): boolean | undefined => {
  const parsed = parsePublicModelConfig(value)
  if (!parsed || !isJsonObject(parsed.spec)) {
    return undefined
  }
  const isVisible = parsed.spec.isVisible
  return typeof isVisible === 'boolean' ? isVisible : undefined
}

export const setPublicModelVisibilityInConfig = (value: string, isVisible: boolean): string => {
  const config = parsePublicModelConfig(value)
  if (!config) {
    return value
  }
  const spec = getPublicModelSpec(config)
  spec.isVisible = isVisible
  return JSON.stringify({ ...config, spec }, null, 2)
}

export const getPublicModelAllowedUsersFromConfig = (value: string): string[] => {
  const parsed = parsePublicModelConfig(value)
  if (!parsed || !isJsonObject(parsed.spec)) {
    return []
  }
  const allowedUsers = parsed.spec.allowedUsers
  if (!Array.isArray(allowedUsers)) {
    return []
  }
  return allowedUsers.filter(
    (name): name is string => typeof name === 'string' && name.trim().length > 0
  )
}

export const getPublicModelAllowedUsersEnabledFromConfig = (value: string): boolean => {
  const parsed = parsePublicModelConfig(value)
  if (!parsed || !isJsonObject(parsed.spec)) {
    return false
  }
  return parsed.spec.allowedUsersEnabled === true
}

export const parseAllowedUsersInput = (value: string): string[] => {
  const names = value
    .split(/[\s,，]+/)
    .map(name => name.trim())
    .filter(Boolean)
  return Array.from(new Set(names))
}

export const setPublicModelAllowedUsersEnabledInConfig = (
  value: string,
  enabled: boolean
): string => {
  const config = parsePublicModelConfig(value)
  if (!config) {
    return value
  }
  const spec = getPublicModelSpec(config)
  if (enabled) {
    spec.allowedUsersEnabled = true
  } else {
    delete spec.allowedUsersEnabled
  }
  return JSON.stringify({ ...config, spec }, null, 2)
}

export const setPublicModelAllowedUsersInConfig = (
  value: string,
  allowedUsers: string[]
): string => {
  const config = parsePublicModelConfig(value)
  if (!config) {
    return value
  }
  const spec = getPublicModelSpec(config)
  if (allowedUsers.length > 0) {
    spec.allowedUsers = allowedUsers
  } else {
    delete spec.allowedUsers
  }
  return JSON.stringify({ ...config, spec }, null, 2)
}
