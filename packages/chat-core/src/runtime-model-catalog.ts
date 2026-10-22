import type { UnifiedModel } from './models'
import {
  type CodexOfficialModel,
  type CodexModelProviderType,
  codexOfficialModelName,
  CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME,
} from './codex-official-models'
const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const RESPONSES_API_FORMAT = 'responses'

export function localCodexModelSource(model: {
  providerId: string
  providerName: string
  providerType: CodexModelProviderType
}) {
  return {
    provider: 'local',
    config: {
      weworkModelKind: model.providerType === 'provider' ? 'codex-provider' : 'codex-official',
      codexProviderId: model.providerId,
      codexProviderName: model.providerName,
      codexProviderType: model.providerType,
      ui: {
        family:
          model.providerType === 'provider'
            ? `codex-provider:${encodeURIComponent(model.providerId.toLowerCase())}`
            : 'codex-official',
        ...(model.providerType === 'provider' ? { familyLabel: model.providerName } : {}),
      },
    },
  } satisfies Pick<UnifiedModel, 'provider' | 'config'>
}

function codexPickerDisplayName(displayName: string): string {
  return displayName.replace(/(?<=\d)-(?=[A-Za-z])/g, ' ')
}

const CHATGPT_SLIDER_MODELS_CONFIG = {
  defaultPreset: 'recommended',
  presets: [
    {
      name: 'recommended',
      label: '推荐',
      description: '推荐模型集',
      models: [
        { model: 'gpt-6-luna', reasoning_effort: 'high' },
        { model: 'gpt-6.1-sol', reasoning_effort: 'low' },
        { model: 'gpt-6.1-sol', reasoning_effort: 'medium' },
        { model: 'gpt-6-astra', reasoning_effort: 'low' },
        { model: 'gpt-6-astra', reasoning_effort: 'medium' },
        { model: 'gpt-6-astra', reasoning_effort: 'xhigh' },
      ],
    },
  ],
} as const

export function localCodexModel(
  model: CodexOfficialModel,
  codexAuthConfigured: boolean
): UnifiedModel {
  const source = localCodexModelSource(model)
  const modelLabel = codexPickerDisplayName(model.displayName)
  return {
    name: codexOfficialModelName(model),
    type: 'runtime',
    displayName: modelLabel,
    ...source,
    modelId: model.modelId,
    config: {
      protocol: OPENAI_RESPONSES_PROTOCOL,
      apiFormat: RESPONSES_API_FORMAT,
      ...source.config,
      codexAuthConfigured,
      codexOfficialModelId: model.id,
      codexIsDefault: model.isDefault,
      ui: {
        ...source.config.ui,
        modelLabel,
        reasoningEfforts: model.supportedReasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort,
        controls: ['speed'],
      },
    },
    runtime: {
      family: 'openai.openai-responses',
      provider: 'local',
    },
    isActive: true,
  }
}

export function unavailableCodexModel(message: string): UnifiedModel {
  return {
    name: CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME,
    type: 'runtime',
    displayName: 'CodeX 模型不可用',
    provider: 'local',
    modelId: null,
    config: {
      protocol: OPENAI_RESPONSES_PROTOCOL,
      apiFormat: RESPONSES_API_FORMAT,
      weworkModelKind: 'codex-official',
      codexAuthConfigured: false,
      unavailableReason: message,
      ui: {
        family: 'codex-official',
        modelLabel: 'CodeX 模型不可用',
        controls: [],
        sortOrder: 10,
      },
    },
    runtime: {
      family: 'openai.openai-responses',
      provider: 'local',
    },
    isActive: false,
    compatibilityDisabled: true,
    compatibilityDisabledReason: 'unavailable',
  }
}

export function codexRuntimeModels(
  codexOfficialModels: CodexOfficialModel[] = [],
  codexOfficialError: string | null = null,
  codexAuthConfigured = false
): UnifiedModel[] {
  const officialCatalogModels = codexOfficialModels.filter(
    model => model.providerType === 'official'
  )
  const providerModels = codexOfficialModels
    .filter(model => model.providerType === 'provider')
    .map(model => localCodexModel(model, codexAuthConfigured))

  if (!codexAuthConfigured) {
    return providerModels
  }
  if (!codexOfficialError && officialCatalogModels.length > 0) {
    const runtimeModels = codexOfficialModels.map(model => localCodexModel(model, true))
    const defaultModel = runtimeModels.find(model => model.config?.codexIsDefault === true)
    if (defaultModel) {
      const defaultUi =
        defaultModel.config?.ui &&
        typeof defaultModel.config.ui === 'object' &&
        !Array.isArray(defaultModel.config.ui)
          ? (defaultModel.config.ui as Record<string, unknown>)
          : {}
      defaultModel.config = {
        ...defaultModel.config,
        ui: {
          ...defaultUi,
          defaultModel: true,
          sliderModelsConfig: CHATGPT_SLIDER_MODELS_CONFIG,
        },
      }
    }
    return runtimeModels
  }

  return [
    unavailableCodexModel(codexOfficialError || 'Codex model list returned no available models'),
    ...providerModels,
  ]
}
