import {
  type ModelControlConfig,
  getControlsForModel,
  normalizeModelOptionValue,
} from '@/lib/model-ui'
import type { ModelCompatibilityDisabledReason, ModelOptions, UnifiedModel } from '@/types/api'

export const CODEX_DEFAULT_MODEL_ID = 'gpt-5.6-sol'
export const CODEX_DEFAULT_REASONING_EFFORT = 'medium'
export const CODEX_DEFAULT_SPEED = 'standard'

export function isVisibleModelSelectorControl(control: ModelControlConfig): boolean {
  return control.id !== 'collaborationMode'
}

export interface ModelPowerSetting {
  id: string
  model: UnifiedModel
  modelId: string
  reasoningEffort: string
}

interface ModelPowerSettingDefinition {
  modelId: string
  reasoningEffort: string
}

const CODEX_PRIMARY_POWER_SETTINGS: ModelPowerSettingDefinition[] = [
  { modelId: 'gpt-5.6-terra', reasoningEffort: 'low' },
  { modelId: 'gpt-5.6-sol', reasoningEffort: 'low' },
  { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
  { modelId: 'gpt-5.6-sol', reasoningEffort: 'high' },
  { modelId: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
  { modelId: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
]

const CODEX_TERRA_POWER_SETTINGS: ModelPowerSettingDefinition[] = [
  { modelId: 'gpt-5.6-terra', reasoningEffort: 'low' },
  { modelId: 'gpt-5.6-terra', reasoningEffort: 'medium' },
  { modelId: 'gpt-5.6-terra', reasoningEffort: 'high' },
  { modelId: 'gpt-5.6-terra', reasoningEffort: 'xhigh' },
]

function normalizedModelId(model: UnifiedModel): string {
  return (model.modelId || model.name).trim().toLowerCase()
}

export function isCodexDefaultModel(model: UnifiedModel | null): boolean {
  return Boolean(model && normalizedModelId(model) === CODEX_DEFAULT_MODEL_ID)
}

export function findCodexDefaultModel(models: UnifiedModel[]): UnifiedModel | null {
  return models.find(model => !model.compatibilityDisabled && isCodexDefaultModel(model)) ?? null
}

function resolvePowerSettings(
  definitions: ModelPowerSettingDefinition[],
  models: UnifiedModel[]
): ModelPowerSetting[] {
  return definitions.flatMap(definition => {
    const model = models.find(
      candidate =>
        !candidate.compatibilityDisabled && normalizedModelId(candidate) === definition.modelId
    )
    if (!model) return []

    const reasoningControl = getControlsForModel(model).find(control => control.id === 'reasoning')
    if (!reasoningControl?.options.some(option => option.value === definition.reasoningEffort)) {
      return []
    }

    return [
      {
        id: `${definition.modelId}:${definition.reasoningEffort}`,
        model,
        modelId: definition.modelId,
        reasoningEffort: definition.reasoningEffort,
      },
    ]
  })
}

export function getCodexModelPowerSettings(models: UnifiedModel[]): ModelPowerSetting[] {
  const primarySettings = resolvePowerSettings(CODEX_PRIMARY_POWER_SETTINGS, models)
  if (primarySettings.length >= 4) return primarySettings

  const terraSettings = resolvePowerSettings(CODEX_TERRA_POWER_SETTINGS, models)
  return terraSettings.length >= 4 ? terraSettings : []
}

export function isSelectedPowerSetting(
  setting: ModelPowerSetting,
  selectedModel: UnifiedModel | null,
  reasoningEffort?: string
): boolean {
  return Boolean(
    selectedModel &&
    normalizedModelId(selectedModel) === setting.modelId &&
    normalizeModelOptionValue('reasoning', reasoningEffort) === setting.reasoningEffort
  )
}

export function desktopModelControl(
  control: ModelControlConfig | undefined
): ModelControlConfig | undefined {
  if (!control || control.id !== 'reasoning') {
    return control
  }

  return {
    ...control,
    options: control.options.filter(option => option.value !== 'max'),
  }
}

export function selectedControlOption(control: ModelControlConfig, options: ModelOptions) {
  const requestedValue = normalizeModelOptionValue(control.id, options[control.id])
  return (
    control.options.find(option => option.value === requestedValue) ??
    control.options.find(option => option.value === control.defaultValue) ??
    control.options[0]
  )
}

export function desktopFastModeState(
  control: ModelControlConfig | undefined,
  options: ModelOptions
) {
  const selectedValue = control ? selectedControlOption(control, options)?.value : undefined
  const available = Boolean(
    control?.options.some(option => option.value === 'fast') &&
    control.options.some(option => option.value === 'standard')
  )
  return {
    available,
    enabled: selectedValue === 'fast',
    nextValue: selectedValue === 'fast' ? 'standard' : 'fast',
  }
}

export function modelCompatibilityDisabledMessage(
  reason: ModelCompatibilityDisabledReason | undefined,
  resolveLabel: (key: string, fallback: string) => string
): string {
  if (reason === 'missing_current_runtime_family') {
    return resolveLabel(
      'workbench.model_disabled_missing_current_runtime_family',
      'Current model is missing runtime.family'
    )
  }
  if (reason === 'missing_target_runtime_family') {
    return resolveLabel(
      'workbench.model_disabled_missing_target_runtime_family',
      'This model is missing runtime.family'
    )
  }
  if (reason === 'unavailable') {
    return resolveLabel('workbench.model_disabled_unavailable', 'This model is unavailable')
  }
  return resolveLabel(
    'workbench.model_disabled_runtime_family_mismatch',
    'Incompatible with the current model protocol'
  )
}
