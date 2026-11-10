import type { ModelApiFormat as LocalModelApiFormat } from '../host/model-configuration-contract.js'
type LocalModelToolProfile = 'custom' | 'function' | 'shell'
type LocalModelWebSearchMode = 'disabled' | 'cached' | 'live'

export const KIMI_CODING_CONTEXT_WINDOW = 262_144
export const KIMI_K3_CONTEXT_WINDOW = 1_048_576
export const DEEPSEEK_FLASH_MODEL_ID = 'deepseek-flash'
export const DEEPSEEK_V4_FLASH_MODEL_ID = 'deepseek-v4-flash'
export const DEEPSEEK_V4_PRO_MODEL_ID = 'deepseek-v4-pro'
export const DEEPSEEK_V4_CONTEXT_WINDOW = 1_048_576

export type LocalModelProviderProfileId =
  | 'custom'
  | 'deepseek'
  | 'glm'
  | 'kimi'
  | 'kimi-coding'
  | 'minimax'
  | 'minimax-global'

export interface LocalModelProviderProfile {
  id: LocalModelProviderProfileId
  displayName: string
  displayNameKey?: string
  description: string
  baseUrl: string
  modelsBaseUrl?: string
  apiFormat: LocalModelApiFormat
  requestPath: string
  modelsPath?: string
  modelsApiKeyHeader?: 'Authorization' | 'X-Api-Key'
  connectionTest?: LocalModelProviderConnectionTest
  allowedModelIds?: readonly string[]
  toolProfile: LocalModelToolProfile
  group?: string
  contextWindow?: number
  webSearchMode: LocalModelWebSearchMode
  imageGenerationEnabled: boolean
  modelDefaults?: Record<
    string,
    {
      contextWindow?: number
      inputModalities?: readonly string[]
    }
  >
}

export interface DiscoveredLocalModel {
  id: string
  displayName: string
}

export interface LocalModelProviderConnectionTest {
  baseUrl: string
  requestPath: string
  apiFormat: 'openai-chat-completions'
}

const MINIMAX_MODEL_DEFAULTS = {
  'MiniMax-M2.7': { contextWindow: 204_800 },
  'MiniMax-M2.7-highspeed': { contextWindow: 204_800 },
  'MiniMax-M2.5': { contextWindow: 204_800 },
  'MiniMax-M2.5-highspeed': { contextWindow: 204_800 },
  'MiniMax-M2.1': { contextWindow: 204_800 },
  'MiniMax-M2.1-highspeed': { contextWindow: 204_800 },
  'MiniMax-M2': { contextWindow: 204_800 },
}

function miniMaxProviderProfile(
  id: Extract<LocalModelProviderProfileId, 'minimax' | 'minimax-global'>,
  displayName: string,
  displayNameKey: string,
  baseUrl: string,
  modelsBaseUrl: string
): LocalModelProviderProfile {
  return {
    id,
    displayName,
    displayNameKey,
    description: 'MiniMax Anthropic-compatible API',
    baseUrl,
    modelsBaseUrl,
    apiFormat: 'anthropic-messages',
    requestPath: '/v1/messages',
    modelsPath: '/v1/models',
    modelsApiKeyHeader: 'Authorization',
    connectionTest: {
      baseUrl: modelsBaseUrl,
      requestPath: '/v1/text/chatcompletion_v2',
      apiFormat: 'openai-chat-completions',
    },
    toolProfile: 'function',
    group: 'MiniMax',
    contextWindow: 204_800,
    webSearchMode: 'disabled',
    imageGenerationEnabled: false,
    modelDefaults: MINIMAX_MODEL_DEFAULTS,
  }
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
        inputModalities: ['text', 'image'],
      },
      'kimi-for-coding': {
        contextWindow: KIMI_CODING_CONTEXT_WINDOW,
      },
      'kimi-for-coding-highspeed': {
        contextWindow: KIMI_CODING_CONTEXT_WINDOW,
      },
    },
  },
  {
    id: 'kimi',
    displayName: 'Kimi',
    description: 'Kimi API Open Platform',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiFormat: 'openai-chat-completions',
    requestPath: '/chat/completions',
    modelsPath: '/models',
    toolProfile: 'function',
    group: 'Kimi',
    contextWindow: 1_000_000,
    webSearchMode: 'disabled',
    imageGenerationEnabled: false,
    modelDefaults: {
      'kimi-k3': {
        contextWindow: KIMI_K3_CONTEXT_WINDOW,
        inputModalities: ['text', 'image'],
      },
      'kimi-k2.7-code': { contextWindow: 262_144 },
      'kimi-k2.7-code-highspeed': { contextWindow: 262_144 },
      'kimi-k2.6': { contextWindow: 262_144 },
      'kimi-k2.5': { contextWindow: 262_144 },
      'moonshot-v1-8k': { contextWindow: 8_192 },
      'moonshot-v1-32k': { contextWindow: 32_768 },
      'moonshot-v1-128k': { contextWindow: 131_072 },
      'moonshot-v1-8k-vision-preview': {
        contextWindow: 8_192,
        inputModalities: ['text', 'image'],
      },
      'moonshot-v1-32k-vision-preview': {
        contextWindow: 32_768,
        inputModalities: ['text', 'image'],
      },
      'moonshot-v1-128k-vision-preview': {
        contextWindow: 131_072,
        inputModalities: ['text', 'image'],
      },
    },
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    description: 'DeepSeek Responses API for Codex',
    baseUrl: 'https://api.deepseek.com',
    apiFormat: 'openai-responses',
    requestPath: '/responses',
    modelsPath: '/models',
    allowedModelIds: [
      DEEPSEEK_FLASH_MODEL_ID,
      DEEPSEEK_V4_FLASH_MODEL_ID,
      DEEPSEEK_V4_PRO_MODEL_ID,
    ],
    toolProfile: 'function',
    group: 'DeepSeek',
    contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW,
    webSearchMode: 'live',
    imageGenerationEnabled: false,
    modelDefaults: {
      [DEEPSEEK_FLASH_MODEL_ID]: {
        contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW,
      },
      [DEEPSEEK_V4_FLASH_MODEL_ID]: {
        contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW,
      },
      [DEEPSEEK_V4_PRO_MODEL_ID]: {
        contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW,
      },
    },
  },
  {
    id: 'glm',
    displayName: 'GLM',
    description: 'Zhipu AI Open Platform API',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiFormat: 'openai-chat-completions',
    requestPath: '/chat/completions',
    modelsPath: '/models',
    toolProfile: 'function',
    group: 'GLM',
    contextWindow: 200_000,
    webSearchMode: 'disabled',
    imageGenerationEnabled: false,
    modelDefaults: {
      'glm-5.2': { contextWindow: 1_000_000 },
    },
  },
  miniMaxProviderProfile(
    'minimax',
    'MiniMax (China mainland)',
    'workbench.local_model_provider_minimax_cn',
    'https://api.minimaxi.com/anthropic',
    'https://api.minimaxi.com'
  ),
  miniMaxProviderProfile(
    'minimax-global',
    'MiniMax (Global)',
    'workbench.local_model_provider_minimax_global',
    'https://api.minimax.io/anthropic',
    'https://api.minimax.io'
  ),
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
