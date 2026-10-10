import { useCallback, useMemo } from "react";
import type { CollaborationTranslate } from "../i18n";
import {
  type ModelControlConfig,
  getControlsForModel,
  getModelDisplayLabel,
  isSameModelSelection,
  normalizeModelOptionValue,
} from "./model-ui";
import type { ModelOptions, UnifiedModel } from "@wegent/chat-core/models";
import { ReasoningSlider } from "./ReasoningSlider";
import {
  type ModelPowerSetting,
  isSelectedPowerSetting,
} from "./model-selector-utils";

interface ModelPowerSliderProps {
  translate: CollaborationTranslate;
  control: ModelControlConfig;
  powerSettings: ModelPowerSetting[];
  selectedModel: UnifiedModel | null;
  selectedModelOptions: ModelOptions;
  onSelectModel: (model: UnifiedModel | null) => boolean | void;
  onSelectModelAndOptions?: (
    model: UnifiedModel,
    options: ModelOptions,
  ) => void;
  onSelectModelOption: (optionId: string, value: string) => void;
  onInteractionChange?: (interacting: boolean) => void;
  compact?: boolean;
  accentPulse?: boolean;
}

export function ModelPowerSlider({
  translate: t,
  control,
  powerSettings,
  selectedModel,
  selectedModelOptions,
  onSelectModel,
  onSelectModelAndOptions,
  onSelectModelOption,
  onInteractionChange,
  compact = false,
  accentPulse = false,
}: ModelPowerSliderProps) {
  const resolveLabel = useCallback(
    (key: string, fallback: string) => t(key, fallback),
    [t],
  );
  const selectedReasoningValue =
    normalizeModelOptionValue("reasoning", selectedModelOptions.reasoning) ??
    control.defaultValue;
  const selectedPowerSetting = powerSettings.find((setting) =>
    isSelectedPowerSetting(setting, selectedModel, selectedReasoningValue),
  );
  const steps = useMemo(
    () =>
      powerSettings.map((setting) => {
        const targetReasoningControl = getControlsForModel(setting.model).find(
          (candidate) => candidate.id === "reasoning",
        );
        const targetReasoningOption = targetReasoningControl?.options.find(
          (option) => option.value === setting.reasoningEffort,
        );
        const reasoningLabel = targetReasoningOption
          ? targetReasoningOption.labelKey
            ? resolveLabel(
                targetReasoningOption.labelKey,
                targetReasoningOption.label,
              )
            : targetReasoningOption.label
          : setting.reasoningEffort;
        return {
          value: setting.id,
          label: `${getModelDisplayLabel(setting.model, {}, resolveLabel)} ${reasoningLabel}`,
          dataTestId: `model-power-setting-${setting.id.replace(/[^a-z0-9]+/giu, "-")}`,
        };
      }),
    [powerSettings, resolveLabel],
  );
  const selectPowerSetting = useCallback(
    (settingId: string) => {
      const setting = powerSettings.find(
        (candidate) => candidate.id === settingId,
      );
      if (!setting) return;

      if (isSameModelSelection(setting.model, selectedModel)) {
        onSelectModelOption("reasoning", setting.reasoningEffort);
        return;
      }
      const nextOptions = {
        ...selectedModelOptions,
        reasoning: setting.reasoningEffort,
      };
      if (onSelectModelAndOptions) {
        onSelectModelAndOptions(setting.model, nextOptions);
        return;
      }
      onSelectModel(setting.model);
      onSelectModelOption("reasoning", setting.reasoningEffort);
    },
    [
      onSelectModel,
      onSelectModelAndOptions,
      onSelectModelOption,
      powerSettings,
      selectedModel,
      selectedModelOptions,
    ],
  );

  return (
    <ReasoningSlider
      translate={t}
      control={control}
      selectedModelOptions={selectedModelOptions}
      onSelectOption={onSelectModelOption}
      compact={compact}
      clearSubmenuOnHover={false}
      onInteractionChange={onInteractionChange}
      steps={steps.length > 0 ? steps : undefined}
      selectedStepValue={selectedPowerSetting?.id}
      onSelectStep={steps.length > 0 ? selectPowerSetting : undefined}
      accentPulse={accentPulse}
    />
  );
}
