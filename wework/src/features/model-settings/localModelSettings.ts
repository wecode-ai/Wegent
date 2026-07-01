export interface LocalModelConfig {
  id: string
  displayName: string
  modelId: string
  baseUrl: string
  apiKey?: string
  enabled: boolean
  updatedAt: string
}

export interface SaveLocalModelConfigInput {
  id?: string | null
  displayName?: string | null
  modelId: string
  baseUrl: string
  apiKey?: string | null
  enabled?: boolean
}

export const LOCAL_MODEL_SETTINGS_STORAGE_KEY = 'wework.localModelSettings.v1'
export const LOCAL_MODEL_SETTINGS_CHANGED_EVENT = 'wework:local-model-settings-changed'
export const LOCAL_MODEL_NAME_PREFIX = 'local-model:'

function readStoredConfigs(): LocalModelConfig[] {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_MODEL_SETTINGS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isLocalModelConfig)
  } catch {
    return []
  }
}

function isLocalModelConfig(value: unknown): value is LocalModelConfig {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.displayName === 'string' &&
    typeof record.modelId === 'string' &&
    typeof record.baseUrl === 'string' &&
    typeof record.enabled === 'boolean' &&
    typeof record.updatedAt === 'string' &&
    (record.apiKey === undefined || typeof record.apiKey === 'string')
  )
}

function writeStoredConfigs(configs: LocalModelConfig[]): void {
  globalThis.localStorage?.setItem(LOCAL_MODEL_SETTINGS_STORAGE_KEY, JSON.stringify(configs))
  dispatchChanged(configs)
}

function dispatchChanged(configs: LocalModelConfig[]): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, {
      detail: { configs },
    })
  )
}

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('Model URL is required')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Model URL must be a valid HTTP URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Model URL must be a valid HTTP URL')
  }

  return trimmed
}

function normalizeModelId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Model ID is required')
  }
  return trimmed
}

function nextConfigId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now().toString(36)}`
}

export function listLocalModelConfigs(): LocalModelConfig[] {
  return readStoredConfigs()
}

export function saveLocalModelConfig(input: SaveLocalModelConfigInput): LocalModelConfig {
  const modelId = normalizeModelId(input.modelId)
  const baseUrl = normalizeHttpUrl(input.baseUrl)
  const displayName = input.displayName?.trim() || modelId
  const apiKey = input.apiKey?.trim() || undefined
  const id = input.id?.trim() || nextConfigId()
  const existing = readStoredConfigs()
  const previous = existing.find(config => config.id === id)
  const next: LocalModelConfig = {
    id,
    displayName,
    modelId,
    baseUrl,
    apiKey,
    enabled: input.enabled ?? previous?.enabled ?? true,
    updatedAt: new Date().toISOString(),
  }
  const index = existing.findIndex(config => config.id === id)
  const configs =
    index >= 0 ? existing.map(config => (config.id === id ? next : config)) : [...existing, next]
  writeStoredConfigs(configs)
  return next
}

export function deleteLocalModelConfig(id: string): boolean {
  const configs = readStoredConfigs()
  const next = configs.filter(config => config.id !== id)
  if (next.length === configs.length) return false
  writeStoredConfigs(next)
  return true
}

export function clearLocalModelConfigs(): void {
  globalThis.localStorage?.removeItem(LOCAL_MODEL_SETTINGS_STORAGE_KEY)
  dispatchChanged([])
}

export function localModelName(configOrId: LocalModelConfig | string): string {
  const id = typeof configOrId === 'string' ? configOrId : configOrId.id
  return `${LOCAL_MODEL_NAME_PREFIX}${id}`
}

export function localModelIdFromModelName(modelName?: string | null): string | null {
  if (!modelName?.startsWith(LOCAL_MODEL_NAME_PREFIX)) return null
  return modelName.slice(LOCAL_MODEL_NAME_PREFIX.length) || null
}

export function findLocalModelConfigByModelName(
  modelName?: string | null
): LocalModelConfig | null {
  const id = localModelIdFromModelName(modelName)
  if (!id) return null
  return readStoredConfigs().find(config => config.id === id) ?? null
}
