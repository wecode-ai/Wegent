import type { LocalHarnessId } from '@/lib/local-harness'
import { getDefaultModelOptions } from '@/lib/model-ui'
import type { ModelOptions, UnifiedModel } from '@/types/api'
import type { HarnessContextRegistration } from '@/features/harness-apps/harnessContext'

export interface LocalHarnessModelOption {
  key: string
  label: string
  source: 'local' | 'cloud'
  model: UnifiedModel
  options: ModelOptions
}

export interface LocalHarnessModelLaunchConfig {
  modelId: string
  env: Record<string, string>
  proxyToken: string
  baseUrl: string
  context?: HarnessContextRegistration
}

export interface HarnessProxyRegistration {
  token: string
  baseUrl: string
}

const HARNESS_MODEL_ALIAS = 'wework-selected'

export function localHarnessModelOptionKey(model: UnifiedModel): string {
  return [
    'wework',
    model.type,
    model.namespace ?? '',
    String(model.resourceUserId ?? ''),
    model.name,
  ]
    .map(encodeURIComponent)
    .join(':')
}

export function listLocalHarnessModelOptions(
  _harnessId: LocalHarnessId,
  models: UnifiedModel[],
  selectedModel: UnifiedModel | null = null,
  selectedModelOptions: ModelOptions = {}
): LocalHarnessModelOption[] {
  const options: LocalHarnessModelOption[] = []
  for (const model of models) {
    if (model.isActive === false || model.compatibilityDisabled) continue
    if (model.provider === 'local') {
      const modelKind =
        typeof model.config?.weworkModelKind === 'string' ? model.config.weworkModelKind : ''
      if (modelKind !== 'model-interface') continue
      options.push({
        key: localHarnessModelOptionKey(model),
        label: model.displayName?.trim() || model.modelId?.trim() || model.name,
        source: 'local',
        model,
        options:
          selectedModel?.name === model.name && selectedModel.type === model.type
            ? selectedModelOptions
            : getDefaultModelOptions(model),
      })
      continue
    }
    if (
      !['public', 'user', 'group'].includes(model.type) ||
      !model.namespace ||
      typeof model.resourceUserId !== 'number'
    ) {
      continue
    }
    options.push({
      key: localHarnessModelOptionKey(model),
      label: model.displayName?.trim() || model.modelId?.trim() || model.name,
      source: 'cloud',
      model,
      options:
        selectedModel?.name === model.name && selectedModel.type === model.type
          ? selectedModelOptions
          : getDefaultModelOptions(model),
    })
  }
  return options
}

export function harnessLaunchThroughMessagesProxy(
  harnessId: LocalHarnessId,
  option: LocalHarnessModelOption,
  registration: HarnessProxyRegistration
): LocalHarnessModelLaunchConfig {
  if (harnessId === 'claude_code') {
    return {
      modelId: HARNESS_MODEL_ALIAS,
      proxyToken: registration.token,
      baseUrl: registration.baseUrl,
      env: {
        ANTHROPIC_BASE_URL: registration.baseUrl,
        ANTHROPIC_API_KEY: 'wework-local-router',
      },
    }
  }
  if (harnessId === 'kimi_code') {
    return {
      modelId: '__kimi_env_model__',
      proxyToken: registration.token,
      baseUrl: registration.baseUrl,
      env: {
        KIMI_MODEL_NAME: HARNESS_MODEL_ALIAS,
        KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
        KIMI_MODEL_BASE_URL: registration.baseUrl,
        KIMI_MODEL_API_KEY: 'wework-local-router',
        KIMI_MODEL_DISPLAY_NAME: option.label,
        ...(option.model.contextWindow
          ? { KIMI_MODEL_MAX_CONTEXT_SIZE: String(option.model.contextWindow) }
          : {}),
        ...(option.model.maxOutputTokens
          ? { KIMI_MODEL_MAX_OUTPUT_SIZE: String(option.model.maxOutputTokens) }
          : {}),
      },
    }
  }

  const providerId = 'wework-messages'
  return {
    modelId: `${providerId}/${HARNESS_MODEL_ALIAS}`,
    proxyToken: registration.token,
    baseUrl: registration.baseUrl,
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          [providerId]: {
            npm: '@ai-sdk/anthropic',
            name: 'Wework model router',
            options: {
              baseURL: `${registration.baseUrl.replace(/\/+$/, '')}/v1`,
              apiKey: 'wework-local-router',
            },
            models: {
              [HARNESS_MODEL_ALIAS]: {
                name: option.label,
                ...(option.model.contextWindow || option.model.maxOutputTokens
                  ? {
                      limit: {
                        ...(option.model.contextWindow
                          ? { context: option.model.contextWindow }
                          : {}),
                        ...(option.model.maxOutputTokens
                          ? { output: option.model.maxOutputTokens }
                          : {}),
                      },
                    }
                  : {}),
              },
            },
          },
        },
      }),
    },
  }
}
