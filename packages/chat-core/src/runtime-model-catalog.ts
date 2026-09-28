import type { UnifiedModel } from './models'
import {
  type CodexOfficialModel,
  codexModelPickerLabel,
  codexModelPickerSortOrder,
  codexOfficialModelName,
  CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME,
} from './codex-official-models'
const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const RESPONSES_API_FORMAT = 'responses'

function localCodexModelFamily(model: CodexOfficialModel): string {
  if (model.providerType !== 'provider') return 'codex-official'
  return `codex-provider:${encodeURIComponent(model.providerId.toLowerCase())}`
}

export function localCodexModel(
  model: CodexOfficialModel,
  codexAuthConfigured: boolean
): UnifiedModel {
  const modelFamily = localCodexModelFamily(model)
  const providerFamilyLabel = model.providerType === 'provider' ? model.providerName : undefined
  const modelLabel = codexModelPickerLabel(model.modelId)
  return {
    name: codexOfficialModelName(model),
    type: 'runtime',
    displayName: modelLabel,
    provider: 'local',
    modelId: model.modelId,
    config: {
      protocol: OPENAI_RESPONSES_PROTOCOL,
      apiFormat: RESPONSES_API_FORMAT,
      weworkModelKind: model.providerType === 'provider' ? 'codex-provider' : 'codex-official',
      codexAuthConfigured,
      codexOfficialModelId: model.id,
      codexProviderId: model.providerId,
      codexProviderName: model.providerName,
      codexProviderType: model.providerType,
      ui: {
        family: modelFamily,
        ...(providerFamilyLabel ? { familyLabel: providerFamilyLabel } : {}),
        modelLabel,
        reasoningEfforts: model.supportedReasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort,
        controls: ['speed'],
        sortOrder:
          (model.providerType === 'provider' ? 100 : 0) + codexModelPickerSortOrder(model.modelId),
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
  const officialModels = !codexAuthConfigured
    ? []
    : codexOfficialError || officialCatalogModels.length === 0
      ? [
          unavailableCodexModel(
            codexOfficialError || 'Codex model list returned no available models'
          ),
        ]
      : officialCatalogModels.map(model => localCodexModel(model, true))
  const providerModels = codexOfficialModels
    .filter(model => model.providerType === 'provider')
    .map(model => localCodexModel(model, codexAuthConfigured))

  return [...officialModels, ...providerModels]
}
