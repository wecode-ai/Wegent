import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import {
  defaultLocalModelRequestPath,
  defaultLocalModelToolProfile,
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
  listLegacyLocalModelConfigs,
  removeMigratedLocalModelConfigs,
  type LocalModelConfig,
} from './localModelSettings'
import { createDefaultLocalModelCatalogEntry } from './localModelCatalog'
import { getProviderModelConfigs, replaceProviderModelConfigs } from './providerModelState'
import type {
  ModelConfigurationSnapshot,
  ModelProvider,
  ProviderModel,
  PublicModelProvider,
  ResolvedProviderModel,
} from '../../../electron/src/host/model-configuration-contract'

export type { ModelConfigurationSnapshot, ModelProvider, ProviderModel, PublicModelProvider }

interface ProviderConfigurationState {
  snapshot: ModelConfigurationSnapshot | null
  error: string | null
}
let state: ProviderConfigurationState = { snapshot: null, error: null }
const listeners = new Set<() => void>()
let initialized: Promise<void> | null = null
let reloadSequence = 0

/** Return the stable snapshot consumed by useSyncExternalStore. */
export function getProviderConfigurationState(): ProviderConfigurationState {
  return state
}
/** Subscribe to configuration changes and return an unsubscribe callback. */
export function subscribeProviderConfiguration(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
/** Replace the observable configuration snapshot and notify its subscribers. */
function publish(snapshot: ModelConfigurationSnapshot | null, error: string | null): void {
  state = { snapshot, error }
  listeners.forEach(listener => listener())
}

/** Project inherited provider settings into the existing runtime model contract without changing IDs. */
export function resolveProviderModel(
  entry: ResolvedProviderModel,
  previous?: LocalModelConfig
): LocalModelConfig {
  const { model, provider } = entry
  const apiFormat = model.api_format ?? provider.api_format
  const toolProfile = model.tool_profile ?? defaultLocalModelToolProfile(apiFormat)
  const displayName = model.display_name || model.model_id
  const profileId = model.provider_profile_id ?? 'custom'
  const catalogEntry =
    model.catalog_entry ??
    (profileId === 'custom'
      ? createDefaultLocalModelCatalogEntry({
          id: model.id,
          displayName,
          toolProfile,
          contextWindow: model.context_window,
        })
      : undefined)
  const requestPath =
    model.request_path ??
    (model.api_format && model.api_format !== provider.api_format
      ? undefined
      : provider.request_path) ??
    (apiFormat === 'anthropic-messages' && provider.base_url.endsWith('/v1')
      ? '/messages'
      : defaultLocalModelRequestPath(apiFormat))
  const config: LocalModelConfig = {
    id: model.id,
    providerConnectionId: provider.id,
    providerProfileId: profileId,
    displayName,
    group: model.group ?? provider.name,
    modelId: model.model_id,
    baseUrl: provider.base_url,
    apiFormat,
    requestPath,
    apiKey: provider.api_key,
    apiKeyConfigured: Boolean(provider.api_key),
    toolProfile,
    codexToolCompatibility:
      apiFormat === 'openai-responses' ? (model.codex_tool_compatibility ?? 'native') : 'standard',
    contextWindow: model.context_window,
    webSearchMode: model.web_search_mode ?? 'disabled',
    imageGenerationEnabled: model.image_generation_enabled ?? false,
    visionModelConfigId: model.vision_model_config_id,
    codexCatalogModelId:
      model.codex_catalog_model_id ??
      (typeof catalogEntry?.slug === 'string' ? catalogEntry.slug : undefined),
    catalogEntry,
    catalogReady:
      !catalogEntry ||
      Boolean(
        previous?.catalogReady &&
        JSON.stringify(previous.catalogEntry) === JSON.stringify(catalogEntry)
      ),
    enabled: provider.enabled !== false && model.enabled !== false,
    updatedAt: previous?.updatedAt ?? new Date().toISOString(),
  }
  if (
    previous &&
    JSON.stringify({ ...config, updatedAt: '' }) === JSON.stringify({ ...previous, updatedAt: '' })
  )
    return previous
  const lastTimestamp = previous ? Date.parse(previous.updatedAt) : 0
  config.updatedAt = new Date(
    Math.max(Date.now(), Number.isFinite(lastTimestamp) ? lastTimestamp + 1 : 0)
  ).toISOString()
  return config
}

/** Load matching public and runtime revisions, ignoring superseded asynchronous requests. */
export async function reloadProviderConfiguration(): Promise<void> {
  const sequence = ++reloadSequence
  try {
    const snapshot = await invokeDesktopHost<ModelConfigurationSnapshot>('modelConfiguration.read')
    const runtime = await invokeDesktopHost<{ revision: string; models: ResolvedProviderModel[] }>(
      'modelConfiguration.runtime'
    )
    if (sequence !== reloadSequence) return
    if (runtime.revision && runtime.revision !== snapshot.revision)
      throw new Error('Model configuration changed while loading. Reload it again.')
    const previous = new Map(getProviderModelConfigs().map(model => [model.id, model]))
    const next = runtime.models.map(entry =>
      resolveProviderModel(entry, previous.get(entry.model.id))
    )
    const changed =
      next.length !== previous.size || next.some(model => model !== previous.get(model.id))
    replaceProviderModelConfigs(next)
    publish(snapshot, snapshot.error ?? null)
    if (changed) window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
  } catch (error) {
    if (sequence === reloadSequence)
      publish(
        state.snapshot,
        error instanceof Error ? error.message : 'Model configuration could not be loaded'
      )
  }
}

/** Initialize the desktop configuration once and subscribe to native revision notifications. */
export function initializeProviderModelConfiguration(): Promise<void> {
  if (!isElectronRuntime()) return Promise.resolve()
  initialized ??= (async () => {
    await reloadProviderConfiguration()
    subscribeDesktopHostEvents(event => {
      if (event.type === 'model-configuration.changed') void reloadProviderConfiguration()
    })
  })()
  return initialized
}

/** Save through the native service and refresh the derived model catalog after persistence. */
export async function saveProviderConfiguration(
  revision: string,
  providers: Array<ModelProvider | PublicModelProvider>
): Promise<void> {
  await invokeDesktopHost('modelConfiguration.save', { revision, providers })
  await reloadProviderConfiguration()
  if (state.error) throw new Error(state.error)
}

/** Bind a selected file through the host and reload only when selection succeeds. */
export async function chooseProviderConfiguration(): Promise<void> {
  const result = await invokeDesktopHost('modelConfiguration.choose')
  if (result) await reloadProviderConfiguration()
}

/** Preserve the legacy model identity, protocol overrides, and capability catalog during migration. */
function modelToFile(config: LocalModelConfig): ProviderModel {
  return {
    id: config.id,
    model_id: config.modelId,
    display_name: config.displayName,
    enabled: config.enabled,
    api_format: config.apiFormat,
    request_path: config.requestPath,
    context_window: config.contextWindow,
    tool_profile: config.toolProfile,
    codex_tool_compatibility: config.codexToolCompatibility,
    web_search_mode: config.webSearchMode,
    image_generation_enabled: config.imageGenerationEnabled,
    vision_model_config_id: config.visionModelConfigId,
    provider_profile_id: config.providerProfileId,
    codex_catalog_model_id: config.codexCatalogModelId,
    catalog_entry: config.catalogEntry,
    group: config.group,
  }
}

/** Group only identical connection credentials and protocols into shared providers. */
export function groupLegacyModels(configs: LocalModelConfig[]): ModelProvider[] {
  const groups = new Map<string, ModelProvider>()
  for (const config of configs) {
    // Never log this internal equality key: credentials distinguish connections.
    const key = JSON.stringify([
      config.baseUrl,
      config.apiKey ?? '',
      config.apiFormat,
      config.requestPath ?? '',
    ])
    let provider = groups.get(key)
    if (!provider) {
      provider = {
        id: `migrated-${crypto.randomUUID()}`,
        name: config.group || new URL(config.baseUrl).hostname,
        base_url: config.baseUrl,
        api_format: config.apiFormat,
        ...(config.requestPath ? { request_path: config.requestPath } : {}),
        ...(config.apiKey ? { api_key: config.apiKey } : {}),
        models: [],
      }
      groups.set(key, provider)
    }
    provider.models.push(modelToFile(config))
  }
  // IPC JSON removes undefined values; doing so here also makes pure tests deterministic.
  return JSON.parse(JSON.stringify([...groups.values()])) as ModelProvider[]
}

/** Persist migrated providers before removing their legacy records, preserving existing IDs. */
export async function migrateLegacyProviderModels(
  snapshot: ModelConfigurationSnapshot
): Promise<void> {
  const ownedIds = new Set(
    snapshot.providers.flatMap(provider => provider.models.map(model => model.id))
  )
  const legacy = listLegacyLocalModelConfigs().filter(model => !ownedIds.has(model.id))
  await saveProviderConfiguration(snapshot.revision, [
    ...snapshot.providers,
    ...groupLegacyModels(legacy),
  ])
  removeMigratedLocalModelConfigs(new Set([...ownedIds, ...legacy.map(model => model.id)]))
}
