export interface LocalModelConfig {
  id: string
  displayName: string
  group?: string
  modelId: string
  baseUrl: string
  requestPath?: string
  apiKey?: string
  contextWindow?: number
  webSearchMode: LocalModelWebSearchMode
  imageGenerationEnabled: boolean
  enabled: boolean
  updatedAt: string
}

export type LocalModelWebSearchMode = 'disabled' | 'cached' | 'live'

export interface SaveLocalModelConfigInput {
  id?: string | null
  displayName?: string | null
  group?: string | null
  modelId: string
  baseUrl: string
  requestPath?: string | null
  apiKey?: string | null
  contextWindow?: number | string | null
  webSearchMode?: LocalModelWebSearchMode | null
  imageGenerationEnabled?: boolean | null
  enabled?: boolean
}

export type LocalModelSettingsEventConfig = Omit<LocalModelConfig, 'apiKey'> & {
  apiKeyConfigured: boolean
}

export const LOCAL_MODEL_SETTINGS_STORAGE_KEY = 'wework.localModelSettings.v1'
export const LOCAL_MODEL_SETTINGS_CHANGED_EVENT = 'wework:local-model-settings-changed'
export const LOCAL_MODEL_NAME_PREFIX = 'local-model:'
export const DEFAULT_LOCAL_MODEL_REQUEST_PATH = '/responses'

function readStoredConfigs(): LocalModelConfig[] {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_MODEL_SETTINGS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isLocalModelConfig).map(normalizeStoredLocalModelConfig)
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
    (record.group === undefined || typeof record.group === 'string') &&
    typeof record.modelId === 'string' &&
    typeof record.baseUrl === 'string' &&
    (record.requestPath === undefined || typeof record.requestPath === 'string') &&
    (record.requestUrlMode === undefined ||
      record.requestUrlMode === 'responses_path' ||
      record.requestUrlMode === 'custom_url') &&
    typeof record.enabled === 'boolean' &&
    typeof record.updatedAt === 'string' &&
    (record.apiKey === undefined || typeof record.apiKey === 'string') &&
    (record.contextWindow === undefined ||
      (typeof record.contextWindow === 'number' &&
        Number.isInteger(record.contextWindow) &&
        record.contextWindow > 0)) &&
    (record.webSearchMode === undefined ||
      record.webSearchMode === 'disabled' ||
      record.webSearchMode === 'cached' ||
      record.webSearchMode === 'live') &&
    (record.imageGenerationEnabled === undefined ||
      typeof record.imageGenerationEnabled === 'boolean')
  )
}

function normalizeStoredLocalModelConfig(config: LocalModelConfig): LocalModelConfig {
  const legacyConfig = config as LocalModelConfig & { requestUrlMode?: string }
  const splitUrl =
    legacyConfig.requestUrlMode === 'custom_url'
      ? splitLocalModelRequestUrl(legacyConfig.baseUrl, legacyConfig.requestPath)
      : {
          baseUrl: legacyConfig.baseUrl,
          requestPath: normalizeLocalModelRequestPath(legacyConfig.requestPath),
        }
  const nextConfig: LocalModelConfig = {
    id: legacyConfig.id,
    displayName: legacyConfig.displayName,
    ...(legacyConfig.group ? { group: legacyConfig.group } : {}),
    modelId: legacyConfig.modelId,
    baseUrl: legacyConfig.baseUrl,
    ...(legacyConfig.apiKey ? { apiKey: legacyConfig.apiKey } : {}),
    ...(legacyConfig.contextWindow ? { contextWindow: legacyConfig.contextWindow } : {}),
    webSearchMode: normalizeLocalModelWebSearchMode(legacyConfig.webSearchMode),
    imageGenerationEnabled: normalizeLocalModelImageGenerationEnabled(
      legacyConfig.imageGenerationEnabled
    ),
    enabled: legacyConfig.enabled,
    updatedAt: legacyConfig.updatedAt,
  }
  return {
    ...nextConfig,
    baseUrl: splitUrl.baseUrl,
    requestPath: normalizeLocalModelRequestPath(splitUrl.requestPath),
  }
}

function writeStoredConfigs(configs: LocalModelConfig[]): void {
  globalThis.localStorage?.setItem(LOCAL_MODEL_SETTINGS_STORAGE_KEY, JSON.stringify(configs))
  dispatchChanged(configs)
}

function dispatchChanged(configs: LocalModelConfig[]): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, {
      detail: { configs: configs.map(redactLocalModelConfig) },
    })
  )
}

function redactLocalModelConfig(config: LocalModelConfig): LocalModelSettingsEventConfig {
  const { apiKey, ...publicConfig } = config
  return {
    ...publicConfig,
    apiKeyConfigured: Boolean(apiKey),
  }
}

export function normalizeLocalModelBaseUrl(value: string): string {
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

export function normalizeLocalModelRequestPath(value?: string | null): string {
  const trimmed = value?.trim() || DEFAULT_LOCAL_MODEL_REQUEST_PATH
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '')
  const path = withoutTrailingSlash.startsWith('/')
    ? withoutTrailingSlash
    : `/${withoutTrailingSlash}`
  return path || DEFAULT_LOCAL_MODEL_REQUEST_PATH
}

export function buildLocalModelRequestUrl(baseUrl: string, requestPath?: string | null): string {
  const splitUrl = splitLocalModelRequestUrl(baseUrl, requestPath)
  return `${normalizeLocalModelBaseUrl(splitUrl.baseUrl)}${normalizeLocalModelRequestPath(
    splitUrl.requestPath
  )}`
}

export function splitLocalModelRequestUrl(
  value: string,
  preferredPath?: string | null
): { baseUrl: string; requestPath: string } {
  const requestPath = normalizeLocalModelRequestPath(preferredPath)
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return { baseUrl: '', requestPath }

  const lowerTrimmed = trimmed.toLowerCase()
  const lowerRequestPath = requestPath.toLowerCase()
  if (lowerTrimmed.endsWith(lowerRequestPath)) {
    return {
      baseUrl: trimmed.slice(0, -requestPath.length).replace(/\/+$/, ''),
      requestPath,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { baseUrl: trimmed, requestPath }
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  const lastSegment = segments.at(-1)
  if (!lastSegment || segments.length < 2 || lastSegment.toLowerCase() === 'v1') {
    return { baseUrl: trimmed, requestPath }
  }

  const basePath = segments.slice(0, -1).join('/')
  const baseUrl = `${parsed.origin}${basePath ? `/${basePath}` : ''}`
  const nextRequestPath = `/${lastSegment}${parsed.search}${parsed.hash}`
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    requestPath: nextRequestPath,
  }
}

export function normalizeLocalModelId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Model ID is required')
  }
  return trimmed
}

export function normalizeLocalModelContextWindow(
  value?: number | string | null
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Context window must be a positive integer')
  }
  return parsed
}

export function normalizeLocalModelGroup(value?: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

export function normalizeLocalModelWebSearchMode(
  value?: LocalModelWebSearchMode | string | null
): LocalModelWebSearchMode {
  if (value === 'cached' || value === 'live') return value
  return 'disabled'
}

export function normalizeLocalModelImageGenerationEnabled(value?: boolean | null): boolean {
  return value === true
}

function nextConfigId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now().toString(36)}`
}

export function listLocalModelConfigs(): LocalModelConfig[] {
  return readStoredConfigs()
}

export function saveLocalModelConfig(input: SaveLocalModelConfigInput): LocalModelConfig {
  const modelId = normalizeLocalModelId(input.modelId)
  const splitUrl = splitLocalModelRequestUrl(input.baseUrl, input.requestPath)
  const baseUrl = normalizeLocalModelBaseUrl(splitUrl.baseUrl)
  const requestPath = normalizeLocalModelRequestPath(splitUrl.requestPath)
  const displayName = input.displayName?.trim() || modelId
  const group = normalizeLocalModelGroup(input.group)
  const apiKey = input.apiKey?.trim() || undefined
  const contextWindow = normalizeLocalModelContextWindow(input.contextWindow)
  const id = input.id?.trim() || nextConfigId()
  const existing = readStoredConfigs()
  const previous = existing.find(config => config.id === id)
  const webSearchMode = normalizeLocalModelWebSearchMode(
    input.webSearchMode ?? previous?.webSearchMode
  )
  const imageGenerationEnabled = normalizeLocalModelImageGenerationEnabled(
    input.imageGenerationEnabled ?? previous?.imageGenerationEnabled
  )
  const next: LocalModelConfig = {
    id,
    displayName,
    ...(group ? { group } : {}),
    modelId,
    baseUrl,
    requestPath,
    apiKey,
    ...(contextWindow ? { contextWindow } : {}),
    webSearchMode,
    imageGenerationEnabled,
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
