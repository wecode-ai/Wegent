import type { LocalModelConfig } from './localModelSettings'
import {
  LOCAL_MODEL_PROVIDER_PROFILES,
  findLocalModelProviderProfile,
  type LocalModelProviderProfile,
  type DiscoveredLocalModel,
} from '../../../electron/src/shared/model-provider-profiles'
export {
  LOCAL_MODEL_PROVIDER_PROFILES,
  findLocalModelProviderProfile,
} from '../../../electron/src/shared/model-provider-profiles'
export type {
  LocalModelProviderProfileId,
  LocalModelProviderProfile,
  DiscoveredLocalModel,
  LocalModelProviderConnectionTest,
} from '../../../electron/src/shared/model-provider-profiles'

export function localModelSupportsImageInput(config: LocalModelConfig): boolean {
  const declaredModalities = config.catalogEntry?.input_modalities
  if (Array.isArray(declaredModalities) && declaredModalities.includes('image')) return true

  const profile = findLocalModelProviderProfile(config.providerProfileId)
  if (profile.modelDefaults?.[config.modelId]?.inputModalities?.includes('image') === true) {
    return true
  }

  const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, '').toLowerCase()
  return LOCAL_MODEL_PROVIDER_PROFILES.some(
    candidate =>
      candidate.id !== 'custom' &&
      candidate.apiFormat === config.apiFormat &&
      candidate.baseUrl.replace(/\/+$/, '').toLowerCase() === normalizedBaseUrl &&
      candidate.modelDefaults?.[config.modelId]?.inputModalities?.includes('image') === true
  )
}

function defaultFetcher(): typeof fetch {
  return globalThis.fetch.bind(globalThis)
}

function modelListError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const value = body as Record<string, unknown>
  const error = value.error
  if (typeof error === 'object' && error) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return typeof value.message === 'string' ? value.message : null
}

export async function discoverProviderModels(
  profile: LocalModelProviderProfile,
  apiKey: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {}
): Promise<DiscoveredLocalModel[]> {
  if (!profile.modelsPath) throw new Error('This provider does not expose a model list')
  if (!apiKey.trim()) throw new Error('API Key is required')

  const fetcher = options.fetcher ?? defaultFetcher()
  const modelsBaseUrl = (profile.modelsBaseUrl ?? profile.baseUrl).replace(/\/+$/, '')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  try {
    const response = await fetcher(`${modelsBaseUrl}/${profile.modelsPath.replace(/^\/+/, '')}`, {
      method: 'GET',
      headers:
        profile.modelsApiKeyHeader === 'X-Api-Key'
          ? { 'X-Api-Key': apiKey.trim() }
          : { Authorization: `Bearer ${apiKey.trim()}` },
      signal: controller.signal,
    })
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw new Error('Provider returned a non-JSON model list', { cause: error })
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${modelListError(body) ?? response.statusText}`)
    }
    const data = (body as { data?: unknown }).data
    if (!Array.isArray(data)) throw new Error('Provider returned an invalid model list')
    const allowedModelIds = profile.allowedModelIds ? new Set(profile.allowedModelIds) : null
    const models = data
      .map(item => {
        if (!item || typeof item !== 'object') return null
        const id = (item as Record<string, unknown>).id
        if (typeof id !== 'string' || !id.trim()) return null
        return { id: id.trim(), displayName: id.trim() }
      })
      .filter((model): model is DiscoveredLocalModel => model !== null)
      .filter(model => !allowedModelIds || allowedModelIds.has(model.id))
      .filter((model, index, all) => all.findIndex(item => item.id === model.id) === index)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
    if (models.length === 0) throw new Error('Provider returned no available models')
    return models
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Loading models timed out', { cause: error })
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}
