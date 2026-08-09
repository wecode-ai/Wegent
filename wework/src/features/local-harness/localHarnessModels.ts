import type { LocalHarnessId } from '@/lib/local-harness'
import type { UnifiedModel } from '@/types/api'

export interface LocalHarnessModelOption {
  key: string
  label: string
  source: 'local' | 'cloud'
  model: UnifiedModel
}

export interface LocalHarnessModelLaunchConfig {
  modelId: string
  env: Record<string, string>
  proxyToken: string
}

export interface HarnessProxyRegistration {
  token: string
  baseUrl: string
}

const HARNESS_MODEL_ALIAS = 'wework-selected'

function modelOptionKey(model: UnifiedModel): string {
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
  models: UnifiedModel[]
): LocalHarnessModelOption[] {
  const options: LocalHarnessModelOption[] = []
  for (const model of models) {
    if (model.isActive === false || model.compatibilityDisabled) continue
    if (model.provider === 'local') {
      const modelKind =
        typeof model.config?.weworkModelKind === 'string' ? model.config.weworkModelKind : ''
      if (modelKind !== 'model-interface') continue
      options.push({
        key: modelOptionKey(model),
        label: model.displayName?.trim() || model.modelId?.trim() || model.name,
        source: 'local',
        model,
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
      key: modelOptionKey(model),
      label: model.displayName?.trim() || model.modelId?.trim() || model.name,
      source: 'cloud',
      model,
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
      env: {
        ANTHROPIC_BASE_URL: registration.baseUrl,
        ANTHROPIC_AUTH_TOKEN: 'wework-local-router',
        ANTHROPIC_API_KEY: 'wework-local-router',
      },
    }
  }

  const providerId = 'wework-messages'
  return {
    modelId: `${providerId}/${HARNESS_MODEL_ALIAS}`,
    proxyToken: registration.token,
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
