import { useEffect, useState } from "react";
import type { ModelOptions, UnifiedModel } from "@wegent/chat-core/models";
import { isSameModelSelection, MODEL_SELECTION_OPTION } from "./model-ui";
import {
  isSelectedPowerSetting,
  type ModelPowerPreset,
} from "./model-selector-utils";

export function useModelPresetSelection(
  presets: ModelPowerPreset[],
  defaultModel: UnifiedModel | null,
  selectedModel: UnifiedModel | null,
  options: ModelOptions,
) {
  const defaultPreset =
    presets.find(
      (preset) =>
        preset.isDefault &&
        defaultModel &&
        isSameModelSelection(preset.owner, defaultModel),
    ) ??
    presets.find(
      (preset) =>
        defaultModel && isSameModelSelection(preset.owner, defaultModel),
    ) ??
    presets.find((preset) => preset.isDefault) ??
    presets[0];
  const intent = options[MODEL_SELECTION_OPTION];
  const persistedPreset = presets.find((preset) => preset.key === intent);
  const initialPreset =
    persistedPreset ??
    presets.find((preset) =>
      preset.settings.some((setting) =>
        isSelectedPowerSetting(setting, selectedModel, options.reasoning),
      ),
    ) ??
    defaultPreset;
  const [choice, setChoice] = useState({
    presetKey: initialPreset?.key,
    explicitModel: intent === "model",
  });
  const activePreset =
    persistedPreset ??
    presets.find((preset) => preset.key === choice.presetKey) ??
    defaultPreset;
  const selectedInPreset = Boolean(
    activePreset?.settings.some((setting) =>
      isSelectedPowerSetting(setting, selectedModel, options.reasoning),
    ),
  );
  // A missing persisted preset must not silently turn a fixed selection into a different set.
  const explicitModel = intent ? !persistedPreset : choice.explicitModel;
  const mode = selectedInPreset && !explicitModel ? "default" : "model";

  useEffect(() => {
    if (!intent && !selectedInPreset) {
      setChoice((current) =>
        current.explicitModel ? { ...current, explicitModel: false } : current,
      );
    }
  }, [intent, selectedInPreset]);

  return {
    defaultPowerPreset: defaultPreset,
    activePowerPreset: activePreset,
    modelSelectionMode: mode,
    defaultModelSelected: mode === "default",
    selectFixedMode: () =>
      setChoice((current) => ({ ...current, explicitModel: true })),
    selectPresetMode: (preset: ModelPowerPreset) =>
      setChoice({ presetKey: preset.key, explicitModel: false }),
  };
}
