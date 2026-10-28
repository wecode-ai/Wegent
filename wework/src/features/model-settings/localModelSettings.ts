import {
  getProviderModelConfigs,
  markProviderModelCatalogReady,
  reconcileProviderModelCatalogRuntime,
} from './providerModelState'
import {
  createDefaultLocalModelCatalogEntry,
  type LocalModelCatalogEntry,
} from './localModelCatalog'
import { codexCatalogModelIdForUpstream } from './codexCatalog'

export const KIMI_CODING_CONTEXT_WINDOW = 262_144
export const KIMI_K3_CONTEXT_WINDOW = 1_048_576
export const DEEPSEEK_FLASH_MODEL_ID = 'deepseek-flash'
export const DEEPSEEK_V4_FLASH_MODEL_ID = 'deepseek-v4-flash'
export const DEEPSEEK_V4_PRO_MODEL_ID = 'deepseek-v4-pro'
export const DEEPSEEK_V4_CONTEXT_WINDOW = 1_048_576

export interface LocalModelConfig {
  id: string
  providerConnectionId?: string
  providerProfileId?: string
  displayName: string
  group?: string
  modelId: string
  baseUrl: string
  apiFormat: LocalModelApiFormat
  codexToolCompatibility?: LocalModelCodexToolCompatibility
  toolProfile: LocalModelToolProfile
  requestPath?: string
  apiKey?: string
  apiKeyConfigured?: boolean
  contextWindow?: number
  maxOutputTokens?: number
  webSearchMode: LocalModelWebSearchMode
  imageGenerationEnabled: boolean
  visionModelConfigId?: string
  codexCatalogModelId?: string
  catalogEntry?: LocalModelCatalogEntry
  catalogReady: boolean
  catalogPendingRuntimeInstanceId?: string
  enabled: boolean
  updatedAt: string
}

export type LocalModelApiFormat =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'

export type LocalModelWebSearchMode = 'disabled' | 'cached' | 'live'

export type LocalModelToolProfile = 'custom' | 'function' | 'shell'

export type LocalModelCodexToolCompatibility = 'native' | 'standard'

export interface CreateLocalModelConfigInput {
  id?: string | null
  providerProfileId?: string | null
  displayName?: string | null
  group?: string | null
  modelId: string
  baseUrl: string
  apiFormat?: LocalModelApiFormat | null
  codexToolCompatibility?: LocalModelCodexToolCompatibility | null
  toolProfile?: LocalModelToolProfile | null
  requestPath?: string | null
  apiKey?: string | null
  contextWindow?: number | string | null
  maxOutputTokens?: number | string | null
  webSearchMode?: LocalModelWebSearchMode | null
  imageGenerationEnabled?: boolean | null
  visionModelConfigId?: string | null
  codexCatalogModelId?: string | null
  catalogEntry?: LocalModelCatalogEntry | null
  catalogReady?: boolean
  catalogPendingRuntimeInstanceId?: string | null
  enabled?: boolean
}

export type LocalModelCatalogSnapshot = Pick<LocalModelConfig, 'id' | 'updatedAt'>

export const LOCAL_MODEL_SETTINGS_STORAGE_KEY = 'wework.localModelSettings.v1'
export const LOCAL_MODEL_SETTINGS_CHANGED_EVENT = 'wework:local-model-settings-changed'
export const LOCAL_MODEL_NAME_PREFIX = 'local-model:'
export const DEFAULT_LOCAL_MODEL_REQUEST_PATH = '/responses'
export const DEFAULT_LOCAL_MODEL_CHAT_COMPLETIONS_REQUEST_PATH = '/chat/completions'
export const DEFAULT_LOCAL_MODEL_ANTHROPIC_MESSAGES_REQUEST_PATH = '/v1/messages'

export function defaultLocalModelRequestPath(apiFormat: LocalModelApiFormat): string {
  if (apiFormat === 'openai-chat-completions') {
    return DEFAULT_LOCAL_MODEL_CHAT_COMPLETIONS_REQUEST_PATH
  }
  if (apiFormat === 'anthropic-messages') {
    return DEFAULT_LOCAL_MODEL_ANTHROPIC_MESSAGES_REQUEST_PATH
  }
  return DEFAULT_LOCAL_MODEL_REQUEST_PATH
}

export function normalizeLocalModelApiFormat(value?: string | null): LocalModelApiFormat {
  return value === 'openai-chat-completions' || value === 'anthropic-messages'
    ? value
    : 'openai-responses'
}

export function normalizeLocalModelCodexToolCompatibility(
  value: string | null | undefined,
  apiFormat: LocalModelApiFormat
): LocalModelCodexToolCompatibility {
  if (apiFormat !== 'openai-responses') return 'standard'
  return value === 'standard' ? 'standard' : 'native'
}

export function defaultLocalModelToolProfile(
  apiFormat: LocalModelApiFormat
): LocalModelToolProfile {
  return apiFormat === 'openai-responses' ? 'custom' : 'function'
}

export function normalizeLocalModelToolProfile(
  value: string | null | undefined,
  apiFormat: LocalModelApiFormat
): LocalModelToolProfile {
  return value === 'custom' || value === 'function' || value === 'shell'
    ? value
    : defaultLocalModelToolProfile(apiFormat)
}

function validateLocalModelToolProfile(
  toolProfile: LocalModelToolProfile,
  apiFormat: LocalModelApiFormat
): void {
  if (toolProfile === 'custom' && apiFormat !== 'openai-responses') {
    throw new Error('Native custom tools require the OpenAI Responses API format')
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

export function normalizeLocalModelRequestPath(
  value?: string | null,
  apiFormat: LocalModelApiFormat = 'openai-responses'
): string {
  const defaultPath = defaultLocalModelRequestPath(apiFormat)
  const trimmed = value?.trim() || defaultPath
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '')
  const path = withoutTrailingSlash.startsWith('/')
    ? withoutTrailingSlash
    : `/${withoutTrailingSlash}`
  return path || defaultPath
}

export function buildLocalModelRequestUrl(
  baseUrl: string,
  requestPath?: string | null,
  apiFormat: LocalModelApiFormat = 'openai-responses'
): string {
  const splitUrl = splitLocalModelRequestUrl(baseUrl, requestPath, apiFormat)
  return `${normalizeLocalModelBaseUrl(splitUrl.baseUrl)}${normalizeLocalModelRequestPath(
    splitUrl.requestPath,
    apiFormat
  )}`
}

/** Provider files store a base prefix, never an inferred complete request URL. */
export function localModelConfigRequestUrl(config: LocalModelConfig): string {
  if (config.providerConnectionId) {
    return `${normalizeLocalModelBaseUrl(config.baseUrl)}${normalizeLocalModelRequestPath(
      config.requestPath,
      config.apiFormat
    )}`
  }
  return buildLocalModelRequestUrl(config.baseUrl, config.requestPath, config.apiFormat)
}

export function splitLocalModelRequestUrl(
  value: string,
  preferredPath?: string | null,
  apiFormat: LocalModelApiFormat = 'openai-responses'
): { baseUrl: string; requestPath: string } {
  const requestPath = normalizeLocalModelRequestPath(preferredPath, apiFormat)
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
  return normalizeLocalModelTokenLimit(value, 'Context window')
}

function normalizeLocalModelTokenLimit(
  value: number | string | null | undefined,
  label: string
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
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

export function createLocalModelConfigId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now().toString(36)}`
}

function nextLocalModelUpdatedAt(previous?: LocalModelConfig): string {
  const previousTimestamp = previous ? Date.parse(previous.updatedAt) : Number.NaN
  const timestamp = Number.isFinite(previousTimestamp)
    ? Math.max(Date.now(), previousTimestamp + 1)
    : Date.now()
  return new Date(timestamp).toISOString()
}

/** Build a normalized connection value without persistence or side effects. */
export function createLocalModelConfig(
  input: CreateLocalModelConfigInput,
  existing: readonly LocalModelConfig[] = []
): LocalModelConfig {
  const modelId = normalizeLocalModelId(input.modelId)
  const apiFormat = normalizeLocalModelApiFormat(input.apiFormat)
  const splitUrl = splitLocalModelRequestUrl(input.baseUrl, input.requestPath, apiFormat)
  const baseUrl = normalizeLocalModelBaseUrl(splitUrl.baseUrl)
  const requestPath = normalizeLocalModelRequestPath(splitUrl.requestPath, apiFormat)
  const displayName = input.displayName?.trim() || modelId
  const group = normalizeLocalModelGroup(input.group)
  const apiKey = input.apiKey?.trim() || undefined
  const contextWindow = normalizeLocalModelContextWindow(input.contextWindow)
  const maxOutputTokens = normalizeLocalModelTokenLimit(input.maxOutputTokens, 'Max output tokens')
  if (contextWindow && maxOutputTokens && maxOutputTokens >= contextWindow) {
    throw new Error('Max output tokens must be less than context window')
  }
  const id = input.id?.trim() || createLocalModelConfigId()
  const previous = existing.find(config => config.id === id)
  const toolProfile = normalizeLocalModelToolProfile(
    input.toolProfile ?? previous?.toolProfile,
    apiFormat
  )
  const codexToolCompatibility = normalizeLocalModelCodexToolCompatibility(
    input.codexToolCompatibility ?? previous?.codexToolCompatibility,
    apiFormat
  )
  validateLocalModelToolProfile(toolProfile, apiFormat)
  const isCustomProvider =
    (input.providerProfileId ?? previous?.providerProfileId ?? 'custom') === 'custom'
  const catalogEntry =
    input.catalogEntry === undefined
      ? (previous?.catalogEntry ??
        (isCustomProvider
          ? createDefaultLocalModelCatalogEntry({
              id,
              displayName,
              toolProfile,
              contextWindow,
            })
          : undefined))
      : (input.catalogEntry ?? undefined)
  const catalogChanged =
    Boolean(catalogEntry) && JSON.stringify(catalogEntry) !== JSON.stringify(previous?.catalogEntry)
  const shouldClearPendingRuntimeInstanceId =
    input.catalogEntry !== undefined || (input.providerProfileId !== undefined && !isCustomProvider)
  const pendingRuntimeInstanceId =
    input.catalogPendingRuntimeInstanceId !== undefined
      ? input.catalogPendingRuntimeInstanceId?.trim() || undefined
      : shouldClearPendingRuntimeInstanceId
        ? undefined
        : previous?.catalogPendingRuntimeInstanceId
  const webSearchMode = normalizeLocalModelWebSearchMode(
    input.webSearchMode ?? previous?.webSearchMode
  )
  const imageGenerationEnabled = normalizeLocalModelImageGenerationEnabled(
    input.imageGenerationEnabled ?? previous?.imageGenerationEnabled
  )
  const visionModelConfigId =
    input.visionModelConfigId === undefined
      ? previous?.visionModelConfigId
      : input.visionModelConfigId?.trim() || undefined
  const enabled = input.enabled ?? previous?.enabled ?? true
  const inferredCatalogModelId = isCustomProvider
    ? null
    : codexCatalogModelIdForUpstream([modelId], apiFormat)
  const codexCatalogModelId =
    input.codexCatalogModelId?.trim() ||
    inferredCatalogModelId ||
    (typeof catalogEntry?.slug === 'string' ? catalogEntry.slug : undefined)
  if (visionModelConfigId === id) {
    throw new Error('Vision proxy model must be different from the primary model')
  }
  if (
    visionModelConfigId &&
    !existing.some(config => config.id === visionModelConfigId && config.enabled)
  ) {
    throw new Error('Vision proxy model is missing or disabled')
  }
  if (!enabled && existing.some(config => config.id !== id && config.visionModelConfigId === id)) {
    throw new Error('Vision proxy model is still referenced by another model')
  }
  const next: LocalModelConfig = {
    id,
    ...(input.providerProfileId ? { providerProfileId: input.providerProfileId } : {}),
    displayName,
    ...(group ? { group } : {}),
    modelId,
    baseUrl,
    apiFormat,
    codexToolCompatibility,
    toolProfile,
    requestPath,
    apiKey,
    apiKeyConfigured: Boolean(apiKey),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    webSearchMode,
    imageGenerationEnabled,
    ...(visionModelConfigId ? { visionModelConfigId } : {}),
    ...(codexCatalogModelId ? { codexCatalogModelId } : {}),
    ...(catalogEntry ? { catalogEntry } : {}),
    catalogReady:
      input.catalogReady ??
      (!catalogEntry ? true : catalogChanged ? false : (previous?.catalogReady ?? false)),
    ...(pendingRuntimeInstanceId
      ? { catalogPendingRuntimeInstanceId: pendingRuntimeInstanceId }
      : {}),
    enabled,
    updatedAt: nextLocalModelUpdatedAt(previous),
  }
  return next
}

/** Runtime catalogs derive exclusively from the native configuration projection. */
export function listLocalModelConfigs(): LocalModelConfig[] {
  return getProviderModelConfigs()
}

export function markLocalModelCatalogReady(snapshot: readonly LocalModelCatalogSnapshot[]): void {
  markProviderModelCatalogReady(snapshot)
}

export function reconcileLocalModelCatalogRuntime(runtimeInstanceId?: string): void {
  if (!runtimeInstanceId) return
  reconcileProviderModelCatalogRuntime(runtimeInstanceId)
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
  const configs = listLocalModelConfigs()
  if (id) return configs.find(config => config.id === id) ?? null
  if (!modelName) return null
  return (
    configs.find(
      config => config.codexCatalogModelId === modelName || config.catalogEntry?.slug === modelName
    ) ?? null
  )
}
