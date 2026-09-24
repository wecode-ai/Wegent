import { parseDocument, type Document } from 'yaml'

export const MODEL_API_FORMATS = [
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
] as const
export type ModelApiFormat = (typeof MODEL_API_FORMATS)[number]

export interface ProviderModel {
  id: string
  model_id: string
  display_name?: string
  enabled?: boolean
  api_format?: ModelApiFormat
  request_path?: string
  context_window?: number
  tool_profile?: 'custom' | 'function' | 'shell'
  codex_tool_compatibility?: 'native' | 'standard'
  web_search_mode?: 'disabled' | 'cached' | 'live'
  image_generation_enabled?: boolean
  vision_model_config_id?: string
  provider_profile_id?: string
  codex_catalog_model_id?: string
  catalog_entry?: Record<string, unknown>
  group?: string
}

export interface ModelProvider {
  id: string
  name: string
  base_url: string
  api_format: ModelApiFormat
  request_path?: string
  models_path?: string
  api_key?: string
  api_key_ref?: string
  models_api_key_header?: 'Authorization' | 'X-Api-Key'
  enabled?: boolean
  models: ProviderModel[]
}

export type PublicModelProvider = Omit<ModelProvider, 'api_key'> & {
  api_key_configured: boolean
}
export interface ModelConfiguration {
  version: 1
  providers: ModelProvider[]
}
export interface ModelConfigurationSnapshot {
  path: string
  revision: string
  providers: PublicModelProvider[]
  loadedAt: string
  error?: string
}
export interface ResolvedProviderModel {
  provider: Omit<ModelProvider, 'models'>
  model: ProviderModel
}

const PROVIDER_FIELDS = new Set([
  'id',
  'name',
  'base_url',
  'api_format',
  'request_path',
  'models_path',
  'api_key',
  'api_key_ref',
  'models_api_key_header',
  'enabled',
  'models',
])
const MODEL_FIELDS = new Set([
  'id',
  'model_id',
  'display_name',
  'enabled',
  'api_format',
  'request_path',
  'context_window',
  'tool_profile',
  'codex_tool_compatibility',
  'web_search_mode',
  'image_generation_enabled',
  'vision_model_config_id',
  'provider_profile_id',
  'codex_catalog_model_id',
  'catalog_entry',
  'group',
])
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,159}$/
export const MAX_MODEL_CONFIGURATION_BYTES = 2 * 1024 * 1024

function fail(path: string, reason: string): never {
  // Values and YAML snippets can contain credentials. Only report field paths.
  throw new Error(`model.yml: ${path}: ${reason}`)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object')
  return value as Record<string, unknown>
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'expected non-empty text')
  return value.trim()
}

function knownFields(value: Record<string, unknown>, fields: Set<string>, path: string): void {
  if (Object.keys(value).some(key => !fields.has(key))) fail(path, 'unknown field')
}

function optionalBoolean(value: Record<string, unknown>, key: string, path: string): void {
  if (value[key] !== undefined && typeof value[key] !== 'boolean')
    fail(`${path}.${key}`, 'expected a boolean')
}

function optionalEnum(
  value: Record<string, unknown>,
  key: string,
  choices: readonly string[],
  path: string
): void {
  if (value[key] !== undefined && !choices.includes(value[key] as string))
    fail(`${path}.${key}`, 'unsupported value')
}

function optionalText(value: Record<string, unknown>, key: string, path: string): void {
  if (value[key] !== undefined) text(value[key], `${path}.${key}`)
}

function validatePath(value: unknown, path: string): void {
  if (value === undefined) return
  const result = text(value, path)
  if (!result.startsWith('/') || result.startsWith('//') || /[?#\\\s]/.test(result)) {
    fail(path, 'expected an absolute API path without query, fragment or whitespace')
  }
}

function validateModel(value: unknown, path: string, provider: ModelProvider): ProviderModel {
  const item = record(value, path)
  knownFields(item, MODEL_FIELDS, path)
  const id = text(item.id, `${path}.id`)
  if (!ID_PATTERN.test(id))
    fail(`${path}.id`, 'use lowercase letters, digits, underscores or hyphens')
  text(item.model_id, `${path}.model_id`)
  for (const field of [
    'display_name',
    'group',
    'vision_model_config_id',
    'provider_profile_id',
    'codex_catalog_model_id',
  ]) {
    optionalText(item, field, path)
  }
  optionalBoolean(item, 'enabled', path)
  optionalBoolean(item, 'image_generation_enabled', path)
  optionalEnum(item, 'api_format', MODEL_API_FORMATS, path)
  optionalEnum(item, 'tool_profile', ['custom', 'function', 'shell'], path)
  optionalEnum(item, 'codex_tool_compatibility', ['native', 'standard'], path)
  optionalEnum(item, 'web_search_mode', ['disabled', 'cached', 'live'], path)
  validatePath(item.request_path, `${path}.request_path`)
  if (
    item.context_window !== undefined &&
    (!Number.isSafeInteger(item.context_window) || (item.context_window as number) <= 0)
  ) {
    fail(`${path}.context_window`, 'expected a positive integer')
  }
  if (item.catalog_entry !== undefined) record(item.catalog_entry, `${path}.catalog_entry`)
  if (
    item.tool_profile === 'custom' &&
    (item.api_format ?? provider.api_format) !== 'openai-responses'
  ) {
    fail(`${path}.tool_profile`, 'custom tools require Responses')
  }
  return { ...item, id, model_id: (item.model_id as string).trim() } as unknown as ProviderModel
}

export function validateModelConfiguration(value: unknown): ModelConfiguration {
  const root = record(value, 'root')
  knownFields(root, new Set(['version', 'providers']), 'root')
  if (root.version !== 1) fail('version', 'expected 1')
  if (!Array.isArray(root.providers)) fail('providers', 'expected an array')
  const providerIds = new Set<string>()
  const modelIds = new Set<string>()
  const slugs = new Set<string>()
  const providers = root.providers.map((entry, index): ModelProvider => {
    const path = `providers[${index}]`
    const item = record(entry, path)
    knownFields(item, PROVIDER_FIELDS, path)
    const id = text(item.id, `${path}.id`)
    if (!ID_PATTERN.test(id))
      fail(`${path}.id`, 'use lowercase letters, digits, underscores or hyphens')
    if (providerIds.has(id)) fail(`${path}.id`, 'duplicate provider ID')
    providerIds.add(id)
    const name = text(item.name, `${path}.name`)
    const baseUrl = text(item.base_url, `${path}.base_url`).replace(/\/+$/, '')
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      fail(`${path}.base_url`, 'invalid URL')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      fail(`${path}.base_url`, 'use an HTTP(S) URL without credentials, query or fragment')
    }
    const apiFormat = item.api_format ?? 'openai-responses'
    if (!MODEL_API_FORMATS.includes(apiFormat as ModelApiFormat))
      fail(`${path}.api_format`, 'unsupported protocol')
    optionalBoolean(item, 'enabled', path)
    optionalEnum(item, 'models_api_key_header', ['Authorization', 'X-Api-Key'], path)
    validatePath(item.request_path, `${path}.request_path`)
    validatePath(item.models_path, `${path}.models_path`)
    optionalText(item, 'api_key', path)
    optionalText(item, 'api_key_ref', path)
    if (item.api_key !== undefined && item.api_key_ref !== undefined)
      fail(path, 'choose api_key or api_key_ref, not both')
    if (
      item.api_key_ref !== undefined &&
      !/^wework-model-key\.[a-z0-9-]+$/.test(item.api_key_ref as string)
    ) {
      fail(`${path}.api_key_ref`, 'invalid model credential reference')
    }
    if (!Array.isArray(item.models)) fail(`${path}.models`, 'expected an array')
    const provider = {
      ...item,
      id,
      name,
      base_url: baseUrl,
      api_format: apiFormat,
    } as unknown as ModelProvider
    provider.models = item.models.map((model, modelIndex) => {
      const modelPath = `${path}.models[${modelIndex}]`
      const result = validateModel(model, modelPath, provider)
      if (modelIds.has(result.id)) fail(`${modelPath}.id`, 'duplicate model ID')
      modelIds.add(result.id)
      const slug = result.catalog_entry?.slug
      if (typeof slug === 'string') {
        if (slugs.has(slug)) fail(`${modelPath}.catalog_entry.slug`, 'duplicate catalog slug')
        slugs.add(slug)
      }
      return result
    })
    return provider
  })
  // Legacy vision references may still point to an un-migrated local model.
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.vision_model_config_id === model.id)
        fail('vision_model_config_id', 'a model cannot reference itself')
    }
  }
  return { version: 1, providers }
}

export function parseModelConfiguration(source: string): {
  document: Document
  config: ModelConfiguration
} {
  if (Buffer.byteLength(source, 'utf8') > MAX_MODEL_CONFIGURATION_BYTES)
    fail('root', 'file exceeds 2 MiB')
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false })
  if (document.errors.length) {
    const error = document.errors[0]
    const line = source.slice(0, error.pos[0]).split('\n').length
    fail(`line ${line}`, `invalid YAML (${error.code})`)
  }
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 0 })
  } catch {
    fail('root', 'YAML aliases are not supported')
  }
  return { document, config: validateModelConfiguration(value) }
}
