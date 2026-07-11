import { useCallback, useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  type ModelControlConfig,
  getControlsForModel,
  getModelDisplayLabel,
  normalizeModelOptionValue,
} from '@/lib/model-ui'
import type { ModelOptions, UnifiedModel } from '@/types/api'
import { ReasoningSlider } from './ReasoningSlider'
import { getCodexModelPowerSettings, isSelectedPowerSetting } from './model-selector-utils'

interface ModelPowerSliderProps {
  control: ModelControlConfig
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelAndOptions?: (model: UnifiedModel, options: ModelOptions) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onInteractionChange?: (interacting: boolean) => void
}

export function ModelPowerSlider({
  control,
  models,
  selectedModel,
  selectedModelOptions,
  onSelectModel,
  onSelectModelAndOptions,
  onSelectModelOption,
  onInteractionChange,
}: ModelPowerSliderProps) {
  const { t } = useTranslation('common')
  const resolveLabel = useCallback((key: string, fallback: string) => t(key, fallback), [t])
  const powerSettings = useMemo(() => getCodexModelPowerSettings(models), [models])
  const selectedReasoningValue =
    normalizeModelOptionValue('reasoning', selectedModelOptions.reasoning) ?? control.defaultValue
  const selectedPowerSetting = powerSettings.find(setting =>
    isSelectedPowerSetting(setting, selectedModel, selectedReasoningValue)
  )
  const steps = useMemo(
    () =>
      powerSettings.map(setting => {
        const targetReasoningControl = getControlsForModel(setting.model).find(
          candidate => candidate.id === 'reasoning'
        )
        const targetReasoningOption = targetReasoningControl?.options.find(
          option => option.value === setting.reasoningEffort
        )
        const reasoningLabel = targetReasoningOption
          ? targetReasoningOption.labelKey
            ? resolveLabel(targetReasoningOption.labelKey, targetReasoningOption.label)
            : targetReasoningOption.label
          : setting.reasoningEffort
        return {
          value: setting.id,
          label: `${getModelDisplayLabel(setting.model, {}, resolveLabel)} ${reasoningLabel}`,
          dataTestId: `model-power-setting-${setting.id.replace(/[^a-z0-9]+/giu, '-')}`,
          ultra: setting.reasoningEffort === 'ultra',
        }
      }),
    [powerSettings, resolveLabel]
  )
  const selectPowerSetting = useCallback(
    (settingId: string) => {
      const setting = powerSettings.find(candidate => candidate.id === settingId)
      if (!setting) return

      const sameModel =
        setting.model.name === selectedModel?.name && setting.model.type === selectedModel?.type
      if (sameModel) {
        onSelectModelOption('reasoning', setting.reasoningEffort)
        return
      }
      const nextOptions = { ...selectedModelOptions, reasoning: setting.reasoningEffort }
      if (onSelectModelAndOptions) {
        onSelectModelAndOptions(setting.model, nextOptions)
        return
      }
      onSelectModel(setting.model)
      onSelectModelOption('reasoning', setting.reasoningEffort)
    },
    [
      onSelectModel,
      onSelectModelAndOptions,
      onSelectModelOption,
      powerSettings,
      selectedModel,
      selectedModelOptions,
    ]
  )

  return (
    <ReasoningSlider
      control={control}
      selectedModelOptions={selectedModelOptions}
      onSelectOption={onSelectModelOption}
      clearSubmenuOnHover={false}
      onInteractionChange={onInteractionChange}
      steps={steps.length > 0 ? steps : undefined}
      selectedStepValue={selectedPowerSetting?.id}
      onSelectStep={steps.length > 0 ? selectPowerSetting : undefined}
    />
  )
}
