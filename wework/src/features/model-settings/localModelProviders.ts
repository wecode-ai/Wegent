import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { shouldUseTauriFetch } from '@/api/http'
import {
  KIMI_CODING_CONTEXT_WINDOW,
  KIMI_K27_CATALOG_MODEL_ID,
  KIMI_K3_CATALOG_MODEL_ID,
  type LocalModelApiFormat,
  type LocalModelToolProfile,
  type LocalModelWebSearchMode,
} from './localModelSettings'

export type LocalModelProviderProfileId = 'custom' | 'kimi-coding'

export interface LocalModelProviderProfile {
  id: LocalModelProviderProfileId
  displayName: string
  description: string
  baseUrl: string
  apiFormat: LocalModelApiFormat
  requestPath: string
  modelsPath?: string
  toolProfile: LocalModelToolProfile
  group?: string
  contextWindow?: number
  webSearchMode: LocalModelWebSearchMode
  imageGenerationEnabled: boolean
  modelDefaults?: Record<
    string,
    {
      contextWindow?: number
      codexCatalogModelId?: string
    }
  >
}

export interface DiscoveredLocalModel {
  id: string
  displayName: string
}

export const LOCAL_MODEL_PROVIDER_PROFILES: LocalModelProviderProfile[] = [
  {
    id: 'kimi-coding',
    displayName: 'Kimi Coding',
    description: 'Kimi Coding API',
    baseUrl: 'https://api.kimi.com/coding/v1',
    apiFormat: 'openai-chat-completions',
    requestPath: '/chat/completions',
    modelsPath: '/models',
    toolProfile: 'function',
    group: 'Kimi',
    contextWindow: KIMI_CODING_CONTEXT_WINDOW,
    webSearchMode: 'disabled',
    imageGenerationEnabled: false,
    modelDefaults: {
      k3: {
        contextWindow: KIMI_CODING_CONTEXT_WINDOW,
        codexCatalogModelId: KIMI_K3_CATALOG_MODEL_ID,
      },
      'kimi-for-coding': {
        contextWindow: KIMI_CODING_CONTEXT_WINDOW,
        codexCatalogModelId: KIMI_K27_CATALOG_MODEL_ID,
      },
      'kimi-for-coding-highspeed': {
        contextWindow: KIMI_CODING_CONTEXT_WINDOW,
        codexCatalogModelId: KIMI_K27_CATALOG_MODEL_ID,
      },
    },
  },
  {
    id: 'custom',
    displayName: 'Custom',
    description: 'Configure any compatible model endpoint',
    baseUrl: '',
    apiFormat: 'openai-responses',
    requestPath: '/responses',
    toolProfile: 'custom',
    webSearchMode: 'disabled',
    imageGenerationEnabled: false,
  },
]

export function findLocalModelProviderProfile(id?: string | null): LocalModelProviderProfile {
  return (
    LOCAL_MODEL_PROVIDER_PROFILES.find(profile => profile.id === id) ??
    LOCAL_MODEL_PROVIDER_PROFILES.find(profile => profile.id === 'custom')!
  )
}

function defaultFetcher(): typeof fetch {
  return shouldUseTauriFetch() ? (tauriFetch as typeof fetch) : globalThis.fetch.bind(globalThis)
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
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  try {
    const response = await fetcher(
      `${profile.baseUrl.replace(/\/+$/, '')}/${profile.modelsPath.replace(/^\/+/, '')}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        signal: controller.signal,
      }
    )
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
    const models = data
      .map(item => {
        if (!item || typeof item !== 'object') return null
        const id = (item as Record<string, unknown>).id
        if (typeof id !== 'string' || !id.trim()) return null
        return { id: id.trim(), displayName: id.trim() }
      })
      .filter((model): model is DiscoveredLocalModel => model !== null)
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
